import test from "node:test";
import assert from "node:assert/strict";
import { runTrackingJob, trackingMatches } from "../web/js/tracking/client.js";

const payload = { assetIds: ["a"], width: 20, height: 16, points: [[2, 3]] };

test("polls progress and returns cached trajectories for later calibration", async () => {
  const calls = [], progress = [];
  const api = {
    startTracking: async (pid, body) => { calls.push([pid, body]); return { id: "job" }; },
    trackingJob: async () => calls.length === 1
      ? (calls.push("poll"), { state: "running", done: 1, total: 2 })
      : { state: "completed", result: { tracks: [1, 2] } },
  };
  const result = await runTrackingJob(api, "project", payload, {
    delay: async () => {}, onProgress: p => progress.push(p.done),
  });
  assert.deepEqual(result.tracks, [1, 2]);
  assert.equal(calls.filter(Array.isArray).length, 1);
  assert.deepEqual(progress, [1]);
});

test("cancels a job even when the user aborts while submission is in flight", async () => {
  const controller = new AbortController(), cancelled = [];
  const api = {
    startTracking: async () => { controller.abort(); return { id: "late-job" }; },
    cancelTracking: async (pid, id) => cancelled.push([pid, id]),
  };
  await assert.rejects(runTrackingJob(api, "project", payload, { signal: controller.signal }),
    e => e.name === "AbortError");
  assert.deepEqual(cancelled, [["project", "late-job"]]);
});

test("failed jobs report the backend error instead of being treated as usable tracks", async () => {
  const api = {
    startTracking: async () => ({ id: "job" }),
    trackingJob: async () => ({ state: "failed", error: "model unavailable" }),
  };
  await assert.rejects(runTrackingJob(api, "p", payload), /model unavailable/);
});

test("a lost polling connection cancels the submitted task instead of leaving GPU work orphaned", async () => {
  const cancelled = [];
  const api = {
    startTracking: async () => ({ id: "job" }),
    trackingJob: async () => { throw new Error("connection lost"); },
    cancelTracking: async (pid, id) => cancelled.push([pid, id]),
  };
  await assert.rejects(runTrackingJob(api, "project", payload), /connection lost/);
  assert.deepEqual(cancelled, [["project", "job"]]);
});

test("saved tracks are valid only for the same image content and selected points", () => {
  const cached = { sourceFingerprint: "same", points: [[2, 3]], tracks: [1] };
  assert.equal(trackingMatches(cached, "same", [[2, 3]]), true);
  assert.equal(trackingMatches(cached, "changed", [[2, 3]]), false);
  assert.equal(trackingMatches(cached, "same", [[4, 3]]), false);
  assert.equal(trackingMatches(null, "same", [[2, 3]]), false);
});
