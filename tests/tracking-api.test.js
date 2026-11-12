import test from "node:test";
import assert from "node:assert/strict";
import { api } from "../web/js/core/api.js";

function respondWith(t, status, data) {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify(data), {
    status, headers: { "Content-Type": "application/json" },
  });
  t.after(() => { globalThis.fetch = original; });
}

test("an old server without tracking routes tells the user to restart the server", async t => {
  respondWith(t, 404, { error: "接口不存在" });
  await assert.rejects(api.trackingStatus(), error => /重启/.test(error.message) && /start\.bat/.test(error.message));
  await assert.rejects(api.startTracking("project", {}), /重启/);
});

test("a lost tracking job preserves its specific error instead of claiming an outdated server", async t => {
  respondWith(t, 404, { error: "跟踪任务不存在" });
  await assert.rejects(api.trackingJob("project", "missing"), /^Error: 跟踪任务不存在$/);
});

test("unrelated API failures preserve their original message", async t => {
  respondWith(t, 404, { error: "接口不存在" });
  await assert.rejects(api.loadProject("missing"), /^Error: 接口不存在$/);
});
