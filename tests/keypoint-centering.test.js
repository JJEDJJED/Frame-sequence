import test from "node:test";
import assert from "node:assert/strict";
import { computeKeypointAlignment } from "../web/js/imaging/keypointAlign.js";

const box = (x, y, w, h, area = w * h) => ({ bounds: { x, y, w, h }, area });
const frame = (...components) => ({ components, contentBounds: components.length ? {
  x: Math.min(...components.map(c => c.bounds.x)), y: Math.min(...components.map(c => c.bounds.y)),
  w: Math.max(...components.map(c => c.bounds.x + c.bounds.w)) - Math.min(...components.map(c => c.bounds.x)),
  h: Math.max(...components.map(c => c.bounds.y + c.bounds.h)) - Math.min(...components.map(c => c.bounds.y)),
} : null });
const bodies = [box(15, 15, 12, 20), box(52, 3, 12, 20), box(35, 60, 12, 20)];
const subjects = bodies.map(b => frame(b));
const tracking = {
  width: 100, height: 100, points: [[20, 24], [24, 24], [22, 29]],
  tracks: [
    [[20, 24], [24, 24], [22, 29]],
    [[57, 12], [61, 12], [90, 80]],
    [[40, 69], [44, 69], [42, 74]],
  ],
  visibility: [[true, true, true], [true, true, true], [true, true, true]],
};
const checkCentered = (a, centers) => centers.forEach((c, i) => {
  const actual = [c.x + a.offsets[i].dx, c.y + a.offsets[i].dy];
  assert.ok(Math.abs(actual[0] - a.outW / 2) <= 0.5, `frame ${i + 1} horizontal centre: ${actual[0]}`);
  assert.ok(Math.abs(actual[1] - a.outH / 2) <= 0.5, `frame ${i + 1} vertical centre: ${actual[1]}`);
});

const expected = [{ x: 20, y: 24 }, { x: 57, y: 12 }, { x: 40, y: 69 }];
test("recentres the tracked anchor including the off-centre first frame", () => {
  const a = computeKeypointAlignment(tracking, { subjects });
  checkCentered(a, expected);
  assert.notDeepEqual(a.offsets[0], { dx: 0, dy: 0 });
  assert.equal(a.outW, 100); assert.equal(a.outH, 100);
  assert.deepEqual(a.reviewFrames, []);
});

test("a jump remains visually centred even with a saved legacy horizontal or trajectory mode", () => {
  for (const mode of ["both", "x", "y", "trajectory"]) {
    checkCentered(computeKeypointAlignment(tracking, {
      subjects, mode, targetKeyframes: { 1: { x: 30, y: -40 } },
    }), expected);
  }
});

test("occluded, out-of-bounds and nonfinite tracks hold the last reliable tracked anchor", () => {
  const t = structuredClone(tracking);
  t.visibility[1] = [false, false, false];
  t.tracks[2] = [null, [100, 5], [4, Infinity]];
  const a = computeKeypointAlignment(t, { subjects });
  checkCentered(a, [expected[0], expected[0], expected[0]]);
  assert.deepEqual(a.fallbackFrames, [1, 2]);
  assert.equal(a.diagnostics[1].source, "held");
  assert.deepEqual(a.reviewFrames, [1, 2]);
});

test("unavailable tracking never silently moves images to their outline centres", () => {
  const a = computeKeypointAlignment(null, { width: 100, height: 100, subjects });
  assert.deepEqual(a.offsets, subjects.map(() => ({ dx: 0, dy: 0 })));
  assert.deepEqual(a.untrackedFrames, [0, 1, 2]);
});

test("larger disconnected effects cannot change the tracked centre", () => {
  const withEffects = subjects.map(s => frame(...s.components, box(75, 45, 25, 50)));
  const a = computeKeypointAlignment(tracking, { subjects: withEffects });
  checkCentered(a, expected);
  assert.equal(a.diagnostics[0].source, "tracking");
});

test("symmetric canvas expansion keeps the character centred and preserves all visible effects", () => {
  const s = [frame(box(3, 10, 10, 20)), frame(box(70, 55, 14, 25))];
  s[0].contentBounds = { x: 0, y: 5, w: 100, h: 35 };
  s[1].contentBounds = { x: 4, y: 0, w: 96, h: 100 };
  const centers = s.map(f => ({ x: f.components[0].bounds.x + f.components[0].bounds.w / 2,
    y: f.components[0].bounds.y + f.components[0].bounds.h / 2 }));
  const a = computeKeypointAlignment(null, { width: 100, height: 100, subjects: s,
    subjectCenters: Object.fromEntries(centers.map((c, i) => [i, c])) });
  assert.ok(a.outW > 100); assert.ok(a.outH > 100);
  checkCentered(a, centers);
  s.forEach((f, i) => {
    const b = f.contentBounds, o = a.offsets[i];
    assert.ok(b.x + o.dx >= 0 && b.x + b.w + o.dx <= a.outW);
    assert.ok(b.y + o.dy >= 0 && b.y + b.h + o.dy <= a.outH);
  });
});

test("manual subject centres are placed at canvas centre rather than added as arbitrary translation", () => {
  const manual = { 1: { x: 56, y: 20 } };
  const a = computeKeypointAlignment(tracking, { subjects, subjectCenters: manual,
    corrections: { 1: { dx: 600, dy: -400 } } });
  assert.ok(Math.abs(56 + a.offsets[1].dx - a.outW / 2) <= 0.5);
  assert.ok(Math.abs(20 + a.offsets[1].dy - a.outH / 2) <= 0.5);
  assert.equal(a.diagnostics[1].source, "manual");
  assert.deepEqual(manual, { 1: { x: 56, y: 20 } });
});

test("empty frames preserve animation order and do not disable fallback for later frames", () => {
  const a = computeKeypointAlignment(tracking, { width: 100, height: 100,
    subjects: [subjects[0], frame(), subjects[2]] });
  assert.equal(a.offsets.length, 3);
  assert.deepEqual(a.emptyFrames, [1]);
  assert.equal(a.diagnostics[1].source, "empty");
  checkCentered({ ...a, offsets: [a.offsets[0], a.offsets[2]] }, [expected[0], expected[2]]);
});

test("fully transparent animations remain empty and do not grow the canvas", () => {
  const a = computeKeypointAlignment(null, { width: 100, height: 80, subjects: [frame(), frame()] });
  assert.equal(a.outW, 100); assert.equal(a.outH, 80);
  assert.deepEqual(a.offsets, [{ dx: 0, dy: 0 }, { dx: 0, dy: 0 }]);
});

test("integer translations keep mixed odd/even subject sizes within half a pixel of true centre", () => {
  const b = [box(0, 0, 11, 19), box(50, 20, 12, 20), box(40, 50, 13, 18)];
  const centers = b.map(p => ({ x: p.bounds.x + p.bounds.w / 2, y: p.bounds.y + p.bounds.h / 2 }));
  const a = computeKeypointAlignment(null, { width: 101, height: 100, subjects: b.map(x => frame(x)),
    subjectCenters: Object.fromEntries(centers.map((c, i) => [i, c])) });
  checkCentered(a, centers);
  assert.ok(a.offsets.every(o => Number.isInteger(o.dx) && Number.isInteger(o.dy)));
});

test("rejects malformed subject metadata instead of silently producing an off-centre output", () => {
  assert.throws(() => computeKeypointAlignment(null, { width: 100, height: 100,
    subjects: [frame({ bounds: { x: 1, y: 1, w: NaN, h: 20 }, area: 30 })] }), /轮廓|主体|尺寸/);
});
