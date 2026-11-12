import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import net from "node:net";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
test("RTM HTTP endpoints retain mutation guards, asset isolation and setup diagnostics", async t => {
  const prefix = path.join(root, ".uv-cache", "rtm-http-test-"), temp = await mkdtemp(prefix);
  const probe = net.createServer(); probe.listen(0, "127.0.0.1"); await once(probe, "listening");
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const server = spawn(process.execPath, ["server/server.js"], { cwd: root, windowsHide: true,
    env: { ...process.env, PORT: String(port), GUANGTAI_HOME: temp, GUANGTAI_RTM_MODEL: path.join(temp, "missing.onnx") },
    stdio: ["ignore", "pipe", "pipe"] });
  t.after(async () => {
    if (server.exitCode === null) { const stopped = once(server, "exit"); server.kill(); await stopped; }
    assert.ok(path.resolve(temp).startsWith(prefix), "only delete the created RTM test workspace");
    await rm(temp, { recursive: true, force: true });
  });
  await Promise.race([once(server.stdout, "data"), once(server, "exit").then(() => { throw new Error("RTM test server exited"); })]);
  const request = async (route, options = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, { ...options,
      headers: { "X-Guangtai": "1", ...options.headers }, signal: AbortSignal.timeout(10000) });
    return { status: response.status, body: await response.json() };
  };
  const project = await request("/api/projects", { method: "POST", body: JSON.stringify({ name: "RTM test" }) });
  const id = project.body.id, png = await readFile(path.join(root, "tests/fixtures/point.png"));
  const asset = await request(`/api/projects/${id}/assets`, { method: "POST", body: png, headers: { "Content-Type": "image/png" } });
  const body = JSON.stringify({ width: 8, height: 6, assetIds: [asset.body.id] });
  const denied = await fetch(`http://127.0.0.1:${port}/api/projects/${id}/rtm`, { method: "POST", body });
  assert.equal(denied.status, 403);
  assert.equal((await request(`/api/projects/${id}/rtm`, { method: "POST", body, headers: { Origin: "https://foreign.example" } })).status, 403);
  assert.equal((await request(`/api/projects/${id}/rtm`, { method: "POST", body: JSON.stringify({ width: 8, height: 6, assetIds: ["../../secret.png"] }) })).status, 400);
  const started = await request(`/api/projects/${id}/rtm`, { method: "POST", body });
  assert.equal(started.status, 202);
  assert.equal((await request(`/api/projects/other/rtm/${started.body.id}`)).status, 404);
  let job;
  for (let i = 0; i < 100; i++) {
    job = await request(`/api/projects/${id}/rtm/${started.body.id}`);
    if (job.body.state !== "running") break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(job.body.state, "failed");
  assert.match(job.body.error, /rtm:setup/);
  const status = await request("/api/rtm/status");
  assert.equal(status.body.ready, false);
  assert.match(status.body.model, /rtmpose/);
});
