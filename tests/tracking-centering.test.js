import test from "node:test";
import assert from "node:assert/strict";
import { computeKeypointAlignment } from "../web/js/imaging/keypointAlign.js";

const outline = (x = 5, y = 8, w = 80, h = 70) => ({
  components: [{ area: 800, bounds: { x, y, w, h } }], contentBounds: { x, y, w, h },
});
const points = [[30, 30], [42, 30], [30, 42], [42, 42], [36, 36]];
function tracked(transforms) {
  return { width: 100, height: 100, points,
    tracks: transforms.map(f => points.map(p => f(...p))),
    visibility: transforms.map(() => points.map(() => true)),
  };
}
const identity = (x, y) => [x, y];
const at = (a, i, expected) => {
  assert.ok(Math.hypot(a.centers[i].x - expected[0], a.centers[i].y - expected[1]) < 1e-7,
    `frame ${i + 1}: ${JSON.stringify(a.centers[i])}, expected ${expected}`);
  assert.ok(Math.abs(expected[0] + a.offsets[i].dx - a.outW / 2) <= 0.5);
  assert.ok(Math.abs(expected[1] + a.offsets[i].dy - a.outH / 2) <= 0.5);
};

test("the first selected anchor drives centring, independently of the yellow outline", () => {
  const tracking = tracked([identity, (x, y) => [x + 8, y - 4]]);
  const a = computeKeypointAlignment(tracking, { subjects: [outline(), outline(0, 0, 100, 100)] });
  at(a, 0, points[0]); at(a, 1, [38, 26]);
  assert.deepEqual(a.fallbackFrames, []);
});

test("rotation and scale project a virtual centre from multiple points without translation consensus", () => {
  const tracking = tracked([identity, (x, y) => [80 - y, x + 5], (x, y) => [90 - x * 1.5, 90 - y * 1.5]]);
  const a = computeKeypointAlignment(tracking, { subjects: [outline(), outline(), outline()],
    subjectCenters: { 0: { x: 34, y: 33 } } });
  at(a, 0, [34, 33]); at(a, 1, [47, 39]); at(a, 2, [39, 40.5]);
  assert.ok(a.diagnostics[1].reliablePoints >= 4);
  assert.equal(a.diagnostics[1].source, "tracking");
});

test("an outlier cannot drag the fitted centre to a weapon or a detached effect", () => {
  const tracking = tracked([identity, (x, y) => [80 - y, x + 5]]);
  tracking.tracks[1][0] = [4, 95];
  const a = computeKeypointAlignment(tracking, { subjects: [outline(), outline()] });
  at(a, 1, [50, 35]);
  assert.equal(a.diagnostics[1].reliablePoints, 4);
});

test("loss of tracking interpolates the tracked centre using frame timing, never the outline centre", () => {
  const tracking = tracked([identity, identity, (x, y) => [x + 20, y + 10]]);
  tracking.visibility[1].fill(false);
  const a = computeKeypointAlignment(tracking, { subjects: [outline(), outline(80, 80, 20, 20), outline()],
    durations: [100, 300, 100] });
  at(a, 1, [35, 32.5]);
  assert.equal(a.diagnostics[1].source, "interpolated");
  assert.deepEqual(a.fallbackFrames, [1]);
  assert.ok(a.reviewFrames.includes(1));
});

test("lost tail frames hold the last reliable tracked centre instead of following a changing box", () => {
  const tracking = tracked([identity, (x, y) => [x + 4, y + 6], identity]);
  tracking.visibility[2].fill(false);
  const a = computeKeypointAlignment(tracking, { subjects: [outline(), outline(), outline(80, 0, 20, 10)] });
  at(a, 2, [34, 36]);
  assert.equal(a.diagnostics[2].source, "held");
});

test("no usable tracking or manual centre leaves pixels in place and requests tracking", () => {
  const a = computeKeypointAlignment(null, { width: 100, height: 100, subjects: [outline(), outline()] });
  assert.deepEqual(a.offsets, [{ dx: 0, dy: 0 }, { dx: 0, dy: 0 }]);
  assert.deepEqual(a.centers, [null, null]);
  assert.ok(a.diagnostics.every(d => d.source === "untracked"));
  assert.deepEqual(a.reviewFrames, [0, 1]);
});

test("low-visibility coordinates on the character are not silently promoted to trusted points", () => {
  const tracking = tracked([identity, (x, y) => [x + 3, y + 3]]);
  tracking.visibility[1].fill(false);
  const a = computeKeypointAlignment(tracking, { subjects: [outline(), outline()] });
  at(a, 1, points[0]);
  assert.equal(a.diagnostics[1].source, "held");
});

test("automatic support points can reconstruct the centre when the main query is occluded", () => {
  const tracking = { width: 100, height: 100, points: [[30, 30]],
    tracks: [[[30, 30]], [[90, 90]]], visibility: [[true], [false]],
    supportPoints: [[20, 20], [40, 20], [20, 40], [40, 40]],
    supportTracks: [[[20, 20], [40, 20], [20, 40], [40, 40]], [[60, 30], [60, 50], [40, 30], [40, 50]]],
    supportVisibility: [[true, true, true, true], [true, true, true, true]] };
  const a = computeKeypointAlignment(tracking, { subjects: [outline(), outline()] });
  at(a, 1, [50, 40]);
});

test("deforming auxiliary features do not veto consistent user queries", () => {
  const tracking = { width: 100, height: 100, points: [[30, 30], [34, 32]],
    tracks: [[[30, 30], [34, 32]], [[38, 26], [42, 28]]], visibility: [[true, true], [true, true]],
    supportPoints: [[20, 20], [40, 20], [20, 40], [40, 40]],
    supportTracks: [[[20, 20], [40, 20], [20, 40], [40, 40]], [[5, 90], [90, 5], [50, 60], [80, 80]]],
    supportVisibility: [[true, true, true, true], [true, true, true, true]] };
  const a = computeKeypointAlignment(tracking, { subjects: [outline(), outline()] });
  at(a, 1, [38, 26]);
});
