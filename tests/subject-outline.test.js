import test from "node:test";
import assert from "node:assert/strict";
import { analyzeSubjectFrame } from "../web/js/imaging/subject.js";

function raster(w, h, rectangles) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (const [x, y, width, height, alpha = 255] of rectangles) {
    for (let py = y; py < y + height; py++) for (let px = x; px < x + width; px++) {
      data.set([200, 80, 30, alpha], (py * w + px) * 4);
    }
  }
  return { width: w, height: h, data };
}

test("detects the main connected outline and excludes isolated specks from subject candidates", () => {
  const a = analyzeSubjectFrame(raster(40, 30, [[5, 8, 10, 16], [35, 2, 1, 1]]));
  assert.equal(a.components.length, 1);
  assert.deepEqual(a.components[0].bounds, { x: 5, y: 8, w: 10, h: 16 });
  assert.deepEqual(a.contentBounds, { x: 5, y: 2, w: 31, h: 22 });
});

test("keeps separate sizeable subjects available for selection by tracking", () => {
  const a = analyzeSubjectFrame(raster(50, 40, [[2, 2, 10, 20], [30, 15, 12, 18]]));
  assert.equal(a.components.length, 2);
});

test("uses 8-connectivity so diagonal pixel-art edges do not split a character", () => {
  const a = analyzeSubjectFrame(raster(8, 8, [[1, 1, 2, 2], [3, 3, 2, 2]]));
  assert.equal(a.components.length, 1);
  assert.equal(a.components[0].area, 8);
});

test("preserves faint glow bounds and falls back for wholly low-alpha characters", () => {
  const a = analyzeSubjectFrame(raster(30, 20, [[4, 5, 5, 10, 255], [20, 1, 3, 3, 4]]));
  assert.deepEqual(a.components[0].bounds, { x: 4, y: 5, w: 5, h: 10 });
  assert.deepEqual(a.contentBounds, { x: 4, y: 1, w: 19, h: 14 });
  const low = analyzeSubjectFrame(raster(30, 20, [[10, 7, 6, 8, 4]]));
  assert.equal(low.lowAlpha, true);
  assert.deepEqual(low.components[0].bounds, { x: 10, y: 7, w: 6, h: 8 });
});

test("handles an empty transparent frame without inventing a subject", () => {
  const a = analyzeSubjectFrame(raster(10, 10, []));
  assert.deepEqual(a.components, []);
  assert.equal(a.contentBounds, null);
});
