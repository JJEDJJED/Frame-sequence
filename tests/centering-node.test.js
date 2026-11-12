import test from "node:test";
import assert from "node:assert/strict";
import { nodeType } from "../web/js/nodes/registry.js";
import { sequenceFingerprint } from "../web/js/tracking/frames.js";
import * as centeringNode from "../web/js/nodes/types/keypointAlign.js";

// Small canvas fixture for evaluating the node contract in Node. Actual browser
// PNG pixels are checked independently in the end-to-end validation.
class RasterCanvas {
  constructor(width = 1, height = 1) { this.width = width; this.height = height; this.pixels = null; }
  getContext() {
    if (!this.pixels || this.pixels.length !== this.width * this.height * 4) this.pixels = new Uint8ClampedArray(this.width * this.height * 4);
    return {
      getImageData: () => ({ width: this.width, height: this.height, data: this.pixels }),
      drawImage: (source, dx, dy) => {
        assert.ok(Number.isInteger(dx) && Number.isInteger(dy));
        for (let y = 0; y < source.height; y++) for (let x = 0; x < source.width; x++) {
          const tx = x + dx, ty = y + dy;
          if (tx < 0 || ty < 0 || tx >= this.width || ty >= this.height) continue;
          this.pixels.set(source.pixels.subarray((y * source.width + x) * 4, (y * source.width + x) * 4 + 4),
            (ty * this.width + tx) * 4);
        }
      },
    };
  }
}
function input() {
  const frames = [[2, 3, 3, 5], [20, 14, 4, 6]].map(([x, y, w, h], i) => {
    const canvas = new RasterCanvas(32, 24); canvas.getContext();
    for (let py = y; py < y + h; py++) for (let px = x; px < x + w; px++) {
      canvas.pixels.set([200, 60, 20, 255], (py * 32 + px) * 4);
    }
    return { canvas, index: i, duration: 90 + i * 30, label: `frame-${i}` };
  });
  return { kind: "frames", w: 32, h: 24, fps: 9, frames, ver: 10 };
}
function setup(t) {
  const document = globalThis.document, fetch = globalThis.fetch;
  globalThis.document = { createElement: () => new RasterCanvas() };
  globalThis.fetch = () => { throw new Error("evaluation must not call the model or upload assets"); };
  t.after(() => { globalThis.document = document; globalThis.fetch = fetch; });
}
const def = nodeType("keypointAlign");

test("node awaits tracking without moving pixels, preserving frame metadata and source pixels", async t => {
  setup(t);
  const src = input(), before = src.frames.map(f => [...f.canvas.pixels]);
  const r = await def.evaluate(def.defaults(), { src });
  assert.equal(r.outputs.out.fps, src.fps);
  assert.deepEqual(r.outputs.out.frames.map(f => [f.duration, f.index, f.label]), [[90, 0, "frame-0"], [120, 1, "frame-1"]]);
  assert.equal(r.view.untrackedFrames.length, 2);
  assert.equal(r.info.waiting, undefined, "engine reserves info.waiting for a missing-input message");
  assert.match(r.info.text, /等待跟踪/);
  assert.deepEqual(src.frames.map(f => [...f.canvas.pixels]), before);
  assert.deepEqual(r.view.offsets, [{ dx: 0, dy: 0 }, { dx: 0, dy: 0 }]);
  assert.deepEqual(r.outputs.out.frames.map(f => [...f.canvas.pixels]), before);
});

test("stale tracks and stale centres request new tracking and leave the new image in place", async t => {
  setup(t);
  const p = { ...def.defaults(), points: [[3, 4]], tracking: { sourceFingerprint: "old", points: [[3, 4]] },
    subjectCenters: { 0: { x: 30, y: 20 } }, subjectCentersFingerprint: "old" };
  const src = input(), r = await def.evaluate(p, { src });
  assert.equal(r.info.stale, true);
  assert.equal(r.view.centers[0], null);
  assert.equal(r.view.diagnostics[0].source, "untracked");
  assert.notEqual(r.outputs.out.frames[0].canvas, src.frames[0].canvas);
});

test("a current manual centre survives reload and legacy offsets do not override centring", async t => {
  setup(t);
  const src = input(), fingerprint = await sequenceFingerprint(src);
  const p = { ...def.defaults(), mode: "x", corrections: { 0: { dx: -999, dy: 200 } },
    subjectCenters: { 0: { x: 4, y: 7 } }, subjectCentersFingerprint: fingerprint };
  const r = await def.evaluate(JSON.parse(JSON.stringify(p)), { src });
  assert.equal(r.view.diagnostics[0].source, "manual");
  assert.deepEqual(r.view.centers[0], { x: 4, y: 7 });
  assert.ok(Math.abs(4 + r.view.offsets[0].dx - r.outputs.out.w / 2) <= 0.5);
  assert.ok(Math.abs(7 + r.view.offsets[0].dy - r.outputs.out.h / 2) <= 0.5);
});

test("old-image reference points cannot move newly imported frames towards an unrelated effect", async t => {
  setup(t);
  const src = input();
  for (const f of src.frames) {
    for (let y = 20; y < 22; y++) for (let x = 27; x < 29; x++) {
      f.canvas.pixels.set([255, 255, 255, 255], (y * 32 + x) * 4);
    }
  }
  const p = { ...def.defaults(), points: [[27, 20]],
    tracking: { sourceFingerprint: "old-image", points: [[27, 20]] } };
  const r = await def.evaluate(p, { src });
  assert.equal(r.view.centers[0], null);
  assert.deepEqual(r.view.offsets[0], { dx: 0, dy: 0 });
});

test("a saved tracked anchor controls actual output pixels rather than the outline midpoint", async t => {
  setup(t);
  const src = input(), fingerprint = await sequenceFingerprint(src), points = [[3, 4]];
  const p = { ...def.defaults(), points, tracking: { sourceFingerprint: fingerprint, points,
    tracks: [[[3, 4]], [[21, 15]]], visibility: [[true], [true]] } };
  const r = await def.evaluate(p, { src });
  assert.deepEqual(r.view.centers, [{ x: 3, y: 4 }, { x: 21, y: 15 }]);
  assert.ok(r.view.diagnostics.every(d => d.source === "tracking"));
  r.view.centers.forEach((c, i) => {
    const offset = r.view.offsets[i], canvas = r.outputs.out.frames[i].canvas;
    assert.ok(Math.abs(c.x + offset.dx - canvas.width / 2) <= 0.5);
    assert.ok(Math.abs(c.y + offset.dy - canvas.height / 2) <= 0.5);
    const pixel = ((c.y + offset.dy) * canvas.width + c.x + offset.dx) * 4;
    assert.deepEqual([...canvas.pixels.subarray(pixel, pixel + 4)], [200, 60, 20, 255]);
  });
});

test("a clicked centre stores source pixels without carrying preview zoom or changing the desired canvas position", () => {
  let params = { subjectCenters: {}, subjectCentersFingerprint: null };
  const local = {}, visited = [];
  const ctx = {
    input: () => ({ w: 32, h: 24, frames: [{}, {}] }),
    result: () => ({ view: { sourceFingerprint: "current-image" } }),
    params: () => params, set: patch => { params = { ...params, ...patch }; },
    setLocal: patch => Object.assign(local, patch), local: { seekTrackingFrame: i => visited.push(i) },
    toast: message => { throw new Error(message); },
  };
  centeringNode.markSubjectCenter(ctx, 1, { x: 22.5, y: 17, scale: 3 });
  assert.deepEqual(params.subjectCenters, { 1: { x: 22.5, y: 17 } });
  assert.equal(params.subjectCentersFingerprint, "current-image");
  assert.equal(local.showSource, false);
  assert.deepEqual(visited, [1]);
});
