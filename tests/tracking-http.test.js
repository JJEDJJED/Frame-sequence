import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import net from "node:net";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function duplicateLaunch(t, statusCode, body, missingRtm = false) {
  const existing = http.createServer((req, res) => {
    const missing = missingRtm && req.url === "/api/rtm/status";
    res.writeHead(missing ? 404 : statusCode, { "Content-Type": "application/json" });
    res.end(JSON.stringify(missing ? { error: "接口不存在" } : body));
  });
  existing.listen(0, "127.0.0.1"); await once(existing, "listening");
  t.after(() => new Promise(resolve => existing.close(resolve)));
  const child = spawn(process.execPath, ["server/server.js"], {
    cwd: root, windowsHide: true,
    env: { ...process.env, PORT: String(existing.address().port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  let output = "";
  child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
  child.stdout.on("data", text => { output += text; });
  child.stderr.on("data", text => { output += text; });
  const [code] = await once(child, "exit");
  return { code, output };
}

test("a duplicate launch against an old server reports that a restart is required", { timeout: 10000 }, async t => {
  const { code, output } = await duplicateLaunch(t, 404, { error: "接口不存在" });
  assert.equal(code, 1);
  assert.match(output, /start\.bat/);
  assert.match(output, /旧版|重启|不支持/);
});

test("a duplicate launch can still reuse a current server with model dependencies missing", { timeout: 10000 }, async t => {
  const { code, output } = await duplicateLaunch(t, 200, { ready: false, busy: false });
  assert.equal(code, 0, output);
  assert.match(output, /工作室可能已在运行/);
});

test("a duplicate launch detects an older backend that has TAPNext but lacks RTM", { timeout: 10000 }, async t => {
  const { code, output } = await duplicateLaunch(t, 200, { ready: true, busy: false }, true);
  assert.equal(code, 1, output);
  assert.match(output, /重启|不支持/);
});

test("HTTP tracking preserves request guards and only accepts assets of the selected project", async t => {
  const temp = await mkdtemp(path.join(root, ".uv-cache/http-test-"));
  const probe = net.createServer();
  probe.listen(0, "127.0.0.1"); await once(probe, "listening");
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const server = spawn(process.execPath, ["server/server.js"], {
    cwd: root, windowsHide: true,
    env: { ...process.env, PORT: String(port), GUANGTAI_HOME: temp,
      GUANGTAI_TAPNEXT_CHECKPOINT: path.join(temp, "missing.pt") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(async () => {
    if (server.exitCode === null) { const exited = once(server, "exit"); server.kill(); await exited; }
    await rm(temp, { recursive: true, force: true });
  });
  await Promise.race([
    once(server.stdout, "data"),
    once(server, "exit").then(() => { throw new Error("test server exited before listening"); }),
  ]);
  const request = async (url, opts = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}${url}`, {
      ...opts, headers: { "X-Guangtai": "1", ...opts.headers }, signal: AbortSignal.timeout(20000),
    });
    return { status: response.status, body: await response.json() };
  };
  const project = await request("/api/projects", { method: "POST", body: JSON.stringify({ name: "tracking test" }) });
  assert.equal(project.status, 200);
  const id = project.body.id;
  const png = await readFile(path.join(root, "tests/fixtures/point.png"));
  const asset = await request(`/api/projects/${id}/assets`, {
    method: "POST", headers: { "Content-Type": "image/png" }, body: png,
  });
  assert.equal(asset.status, 200);
  const payload = { assetIds: [asset.body.id], width: 8, height: 6, points: [[2, 2]] };
  const denied = await fetch(`http://127.0.0.1:${port}/api/projects/${id}/tracking`, {
    method: "POST", body: JSON.stringify(payload), signal: AbortSignal.timeout(2000),
  });
  assert.equal(denied.status, 403);
  const foreign = await request(`/api/projects/${id}/tracking`, {
    method: "POST", headers: { Origin: "https://foreign.example" }, body: JSON.stringify(payload),
  });
  assert.equal(foreign.status, 403);
  const traversal = await request(`/api/projects/${id}/tracking`, {
    method: "POST", body: JSON.stringify({ ...payload, assetIds: ["../../secret.png"] }),
  });
  assert.equal(traversal.status, 400);
  const created = await request(`/api/projects/${id}/tracking`, { method: "POST", body: JSON.stringify(payload) });
  assert.equal(created.status, 202);
  const jobUrl = `/api/projects/${id}/tracking/${created.body.id}`;
  const wrongProject = await request(`/api/projects/other/tracking/${created.body.id}`);
  assert.equal(wrongProject.status, 404);
  let job;
  for (let i = 0; i < 100; i++) {
    job = await request(jobUrl);
    if (job.body.state !== "running") break;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  assert.equal(job.body.state, "failed");
  assert.match(job.body.error, /tracking:setup/);
  const status = await request("/api/tracking/status");
  assert.equal(status.body.ready, false);
  assert.equal(status.body.isolated, true);
});
