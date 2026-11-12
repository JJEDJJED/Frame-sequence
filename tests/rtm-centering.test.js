import test from "node:test";
import assert from "node:assert/strict";
import { computeRtmAlignment } from "../web/js/imaging/rtmAlign.js";

function pose(shoulder = [30, 25], hip = [30, 45]) {
  const points = Array(17).fill(null), scores = Array(17).fill(0);
  const dx = hip[0] - shoulder[0], dy = hip[1] - shoulder[1], length = Math.hypot(dx, dy) || 1;
  for (const [index, center, side, width] of [[5, shoulder, -1, 5], [6, shoulder, 1, 5], [11, hip, -1, 4], [12, hip, 1, 4]]) {
    points[index] = [center[0] + dy / length * side * width, center[1] - dx / length * side * width];
    scores[index] = 0.9;
  }
  return { points, scores };
}
const subject = () => ({ components: [{ area: 200, bounds: { x: 1, y: 1, w: 98, h: 98 } }],
  contentBounds: { x: 1, y: 1, w: 98, h: 98 } });
const input = (...frames) => ({ width: 100, height: 100, keypoints: frames.map(f => f.points), scores: frames.map(f => f.scores) });
const compute = (frames, options = {}) => computeRtmAlignment(input(...frames), {
  subjects: frames.map(subject), ...options,
});
const close = (p, expected) => assert.ok(p && Math.hypot(p.x - expected[0], p.y - expected[1]) < 1e-7,
  `${JSON.stringify(p)} != ${expected}`);

test("RTM centres the shoulder/hip-defined torso, independently of a foreground box or TAPNext", () => {
  const a = compute([pose(), pose([65, 20], [65, 40])]);
  close(a.centers[0], [30, 35]); close(a.centers[1], [65, 30]);
  assert.ok(a.diagnostics.every(d => d.source === "pose"));
  a.centers.forEach((c, i) => {
    assert.ok(Math.abs(c.x + a.offsets[i].dx - a.outW / 2) <= 0.5);
    assert.ok(Math.abs(c.y + a.offsets[i].dy - a.outH / 2) <= 0.5);
  });
});

test("a calibrated torso position follows rotation rather than retaining a global pixel offset", () => {
  const a = compute([pose(), pose([45, 35], [25, 35])], { anchor: { x: 30, y: 30 } });
  close(a.centers[0], [30, 30]); close(a.centers[1], [40, 35]);
});

test("low confidence shoulders or hips trigger time-based interpolation with a review flag", () => {
  const middle = pose([90, 90], [90, 95]); middle.scores[11] = 0.1;
  const a = compute([pose(), middle, pose([50, 35], [50, 55])], { durations: [100, 300, 100] });
  close(a.centers[1], [35, 37.5]);
  assert.equal(a.diagnostics[1].source, "interpolated");
  assert.equal(a.diagnostics[1].confidence, 0.1, "rejected frames still expose the raw joint score for inspection");
  assert.ok(a.reviewFrames.includes(1));
});

test("nonfinite, off-image and collapsed torsos cannot become trusted centres", () => {
  const invalid = pose(); invalid.points[6] = [NaN, 5];
  const outside = pose(); outside.points[11] = [101, 40];
  const collapsed = pose([30, 30], [30, 30]);
  const a = compute([pose(), invalid, outside, collapsed]);
  assert.deepEqual(a.fallbackFrames, [1, 2, 3]);
  assert.ok(a.diagnostics.slice(1).every(d => d.source === "held"));
});

test("foreground evidence rejects a skeleton joint predicted in empty space", () => {
  const p = input(pose(), pose([50, 40], [50, 60]));
  p.foreground = [Array(17).fill(true), Array(17).fill(true)]; p.foreground[1][5] = false;
  const a = computeRtmAlignment(p, { subjects: [subject(), subject()] });
  assert.equal(a.diagnostics[1].source, "held");
});

test("no accepted RTM pose leaves the source in place instead of inventing a body centre", () => {
  const p = pose(); p.scores.fill(0.01);
  const a = compute([p]);
  assert.deepEqual(a.centers, [null]);
  assert.deepEqual(a.offsets, [{ dx: 0, dy: 0 }]);
  assert.deepEqual(a.unavailableFrames, [0]);
});

test("RTM requires a valid first-frame torso before applying a manual calibration", () => {
  const p = pose(); p.scores.fill(0);
  assert.throws(() => compute([p, pose()], { anchor: { x: 30, y: 30 } }), /首帧|标定/);
});

test("changing the pose score threshold reuses predictions and changes acceptance", () => {
  const p = pose(); p.scores[5] = 0.4;
  assert.equal(compute([p], { threshold: 0.3 }).diagnostics[0].source, "pose");
  assert.equal(compute([p], { threshold: 0.5 }).diagnostics[0].source, "unavailable");
});
