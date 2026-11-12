import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { httpError } from "./projects.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// JSONL over pipes: the model stays loaded and no extra network port is opened.
export class TrackingWorker {
  constructor({ root = ROOT, python, script, setupCommand = "tracking:setup" } = {}) {
    this.root = root;
    this.python = python || process.env.GUANGTAI_TRACKING_PYTHON || path.join(root, ".venv",
      process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
    this.script = script || path.join(root, "python/tracking_worker.py");
    this.child = null;
    this.pending = new Map();
    this.setupCommand = setupCommand;
  }

  get pid() { return this.child?.pid; }

  start() {
    if (this.child) return this.child;
    const child = spawn(this.python, ["-u", this.script], {
      cwd: this.root, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" },
    });
    this.child = child;
    let buffer = "", stderr = "";
    const fail = error => { if (this.child === child) this.close(error); };
    child.on("error", error => fail(new Error(error.code === "ENOENT"
      ? `找不到隔离 Python 环境，请先运行 npm run ${this.setupCommand}` : error.message)));
    child.on("exit", code => fail(new Error(`跟踪进程退出（${code}）${stderr ? ": " + stderr.slice(-2000) : ""}`)));
    child.stdin.on("error", fail);
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", text => { stderr = (stderr + text).slice(-8192); });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", text => {
      if (this.child !== child) return;
      buffer += text;
      if (buffer.length > 8 * 1024 * 1024) { fail(new Error("跟踪进程返回数据过大")); return; }
      let end;
      while ((end = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        if (!line.trim()) continue;
        let message;
        try { message = JSON.parse(line); }
        catch { fail(new Error("跟踪进程协议异常")); return; }
        const pending = this.pending.get(message.id);
        if (!pending) continue;
        if (message.type === "progress") { pending.onProgress?.(message); continue; }
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.type === "result") pending.resolve(message.result);
        else pending.reject(new Error(message.error || "跟踪失败"));
      }
    });
    return child;
  }

  request(payload, { onProgress, timeoutMs = 10 * 60 * 1000 } = {}) {
    return new Promise((resolve, reject) => {
      const child = this.start(), id = randomUUID();
      const timer = setTimeout(() => this.close(new Error("跟踪超时，请减少帧数后重试")), timeoutMs);
      this.pending.set(id, { resolve, reject, onProgress, timer });
      child.stdin.write(JSON.stringify({ ...payload, id }) + "\n", error => {
        if (error && this.child === child) this.close(error);
      });
    });
  }

  close(error = new Error("跟踪已停止或取消")) {
    const child = this.child;
    this.child = null;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    if (child) { child.stdin.destroy(); child.kill(); }
  }
}

function validate(body) {
  const { assetIds, points, width, height } = body;
  if (!Number.isInteger(width) || width < 1 || !Number.isInteger(height) || height < 1
      || width * height > 16 * 1024 * 1024) throw httpError(400, "画布尺寸无效");
  if (!Array.isArray(assetIds) || !assetIds.length || assetIds.length > 512
      || assetIds.some(id => typeof id !== "string" || !id)) throw httpError(400, "请选择 1～512 帧");
  if (!Array.isArray(points) || !points.length || points.length > 16 || points.some(p =>
    !Array.isArray(p) || p.length !== 2 || !p.every(Number.isFinite)
      || p[0] < 0 || p[0] >= width || p[1] < 0 || p[1] >= height)) {
    throw httpError(400, "请选择画布内的 1～16 个参考点");
  }
}

export class TrackingService {
  constructor(workspace, { worker = new TrackingWorker(), validateRequest = validate, operation = "track", label = "跟踪" } = {}) {
    this.workspace = workspace;
    this.worker = worker;
    this.jobs = new Map();
    this.active = null;
    this.lastStatus = null;
    this.validateRequest = validateRequest;
    this.operation = operation;
    this.label = label;
  }

  async status() {
    // A status request must never time out and kill an ongoing inference.
    if (this.active) return { ...(this.lastStatus || {}), busy: true };
    try {
      this.lastStatus = await this.worker.request({ op: "status" }, { timeoutMs: 15000 });
      return { ...this.lastStatus, busy: false };
    } catch (error) { return { ready: false, busy: false, error: error.message }; }
  }

  async start(projectId, body) {
    this.validateRequest(body);
    if (this.active) throw httpError(409, `已有${this.label}任务运行，请等待完成或先取消`);
    const id = randomUUID();
    this.active = id;
    let frames;
    try {
      frames = await Promise.all(body.assetIds.map(aid => this.workspace.assetFile(projectId, aid)));
    } catch (error) { this.active = null; throw error; }
    const job = { id, projectId, state: "running", done: 0, total: frames.length };
    while (this.jobs.size >= 20) this.jobs.delete(this.jobs.keys().next().value);
    this.jobs.set(id, job);
    this.worker.request({ op: this.operation, frames, points: body.points, width: body.width, height: body.height }, {
      onProgress: p => {
        if (job.state === "running") job.done = Math.max(0, Math.min(job.total, p.done));
      },
    }).then(result => {
      if (job.state === "running") Object.assign(job, { state: "completed", done: job.total, result });
    }, error => {
      if (job.state === "running") Object.assign(job, { state: "failed", error: error.message });
    }).finally(() => { if (this.active === id) this.active = null; });
    return { ...job };
  }

  get(projectId, id) {
    const job = this.jobs.get(id);
    if (!job || job.projectId !== projectId) throw httpError(404, `${this.label}任务不存在`);
    return { ...job };
  }

  cancel(projectId, id) {
    const job = this.get(projectId, id);
    if (job.state === "running") {
      this.jobs.get(id).state = "cancelled";
      if (this.active === id) { this.active = null; this.worker.close(); }
    }
    return this.get(projectId, id);
  }

  close() { this.worker.close(); }
}
