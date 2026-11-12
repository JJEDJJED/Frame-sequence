import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TrackingWorker, TrackingService } from "../server/tracking.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const options = { root, script: path.join(root, "tests/fixtures/tracking-worker.py") };

test("Python process persists across requests and a job error does not poison the next job", async t => {
  const worker = new TrackingWorker(options);
  t.after(() => worker.close());
  const first = await worker.request({ op: "status" });
  const pid = worker.pid;
  assert.equal(first.ready, true);
  await assert.rejects(worker.request({ op: "track", points: [[13, 0]], frames: ["x"] }), /fixture failure/);
  const progress = [];
  const result = await worker.request({ op: "track", points: [[2, 3]], frames: ["x", "y"] }, {
    onProgress: p => progress.push(p.done),
  });
  assert.deepEqual(progress, [1, 2]);
  assert.deepEqual(result.tracks, [[[2, 3]], [[2, 3]]]);
  assert.equal(worker.pid, pid);
});

test("worker timeout releases the process and subsequent requests can recover", async t => {
  const worker = new TrackingWorker(options);
  t.after(() => worker.close());
  await worker.request({ op: "status" });
  await assert.rejects(worker.request({ op: "sleep" }, { timeoutMs: 50 }), /超时/);
  assert.equal((await worker.request({ op: "status" })).ready, true);
});

test("closing a running worker rejects its requests instead of leaving promises pending", async () => {
  const worker = new TrackingWorker(options);
  await worker.request({ op: "status" });
  const pending = worker.request({ op: "sleep" });
  const rejection = assert.rejects(pending, /停止|取消/);
  worker.close();
  await rejection;
});

function fakeWorker() {
  return {
    calls: [], closed: false,
    request(payload, opts) {
      this.calls.push(payload);
      if (payload.op === "status") return Promise.resolve({ ready: true });
      this.progress = opts.onProgress;
      return new Promise((resolve, reject) => { this.resolve = resolve; this.reject = reject; });
    },
    close() { this.closed = true; this.reject?.(new Error("已取消")); },
  };
}
const body = { assetIds: ["a.png", "b.png"], points: [[2, 3]], width: 20, height: 16 };

test("jobs resolve only project assets, report progress and isolate results by project", async t => {
  const worker = fakeWorker(), resolved = [];
  const workspace = { assetFile: async (pid, id) => { resolved.push([pid, id]); return `/project/${pid}/${id}`; } };
  const service = new TrackingService(workspace, { worker });
  t.after(() => service.close());
  const job = await service.start("one", body);
  assert.deepEqual(resolved, [["one", "a.png"], ["one", "b.png"]]);
  assert.deepEqual(worker.calls[0].frames, ["/project/one/a.png", "/project/one/b.png"]);
  assert.throws(() => service.get("two", job.id), e => e.status === 404);
  worker.progress({ done: 1, total: 2 });
  assert.equal(service.get("one", job.id).done, 1);
  await assert.rejects(service.start("two", body), e => e.status === 409);
  worker.resolve({ tracks: [1, 2] });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(service.get("one", job.id).state, "completed");
  assert.deepEqual(service.get("one", job.id).result.tracks, [1, 2]);
});

test("cancelling a job releases the worker and never becomes a failed job", async t => {
  const worker = fakeWorker();
  const service = new TrackingService({ assetFile: async () => "frame.png" }, { worker });
  t.after(() => service.close());
  const job = await service.start("one", body);
  service.cancel("one", job.id);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(service.get("one", job.id).state, "cancelled");
  assert.equal(worker.closed, true);
});

test("bad requests are rejected before reaching a Python process", async () => {
  const worker = fakeWorker();
  const service = new TrackingService({ assetFile: async () => "x" }, { worker });
  for (const patch of [{ assetIds: [] }, { assetIds: ["x"], points: [] }, { points: [[20, 2]] },
    { width: -1 }, { width: true }, { points: [[2, null]] }, { assetIds: Array(513).fill("x") }]) {
    await assert.rejects(service.start("one", { ...body, ...patch }), e => e.status === 400);
  }
  assert.equal(worker.calls.length, 0);
});
