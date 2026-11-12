import test from "node:test";
import assert from "node:assert/strict";
import { api } from "../web/js/core/api.js";

test("RTM uses independent endpoints and explains an outdated local backend", async t => {
  const previous = globalThis.fetch, calls = [];
  t.after(() => { globalThis.fetch = previous; });
  globalThis.fetch = async (url, init) => {
    calls.push([url, init.method]);
    return new Response(JSON.stringify({ error: "接口不存在" }), { status: 404 });
  };
  await assert.rejects(api.rtmStatus(), /重启|start\.bat/);
  assert.equal(calls[0][0], "/api/rtm/status");
});
