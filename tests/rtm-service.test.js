import test from "node:test";
import assert from "node:assert/strict";
import { RtmService } from "../server/rtm.js";

test("RTM jobs use a separate estimate operation and do not require TAPNext query points", async t => {
  const calls = [];
  const worker = { request: async payload => { calls.push(payload); return { keypoints: [[]], scores: [[]] }; }, close() {} };
  const service = new RtmService({ assetFile: async (pid, aid) => `/projects/${pid}/${aid}` }, { worker });
  t.after(() => service.close());
  const job = await service.start("pose", { assetIds: ["a.png"], width: 100, height: 100 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls[0].op, "estimate");
  assert.deepEqual(calls[0].frames, ["/projects/pose/a.png"]);
  assert.equal(service.get("pose", job.id).state, "completed");
  assert.throws(() => service.get("other", job.id), e => e.status === 404);
});

test("invalid RTM dimensions and oversized batches are rejected before a worker is used", async () => {
  const service = new RtmService({ assetFile: async () => { throw new Error("must not reach assets"); } }, { worker: {} });
  for (const patch of [{ width: 0 }, { height: true }, { assetIds: [] }, { assetIds: Array(513).fill("a") }]) {
    await assert.rejects(service.start("p", { assetIds: ["a"], width: 100, height: 100, ...patch }), e => e.status === 400);
  }
});
