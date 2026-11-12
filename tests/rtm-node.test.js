import test from "node:test";
import assert from "node:assert/strict";
import { nodeType } from "../web/js/nodes/registry.js";
import { sequenceFingerprint } from "../web/js/tracking/frames.js";
import "../web/js/nodes/types/rtmCenter.js";

class Canvas {
  constructor(width = 1, height = 1) { this.width = width; this.height = height; }
  getContext() {
    this.pixels ||= new Uint8ClampedArray(this.width * this.height * 4);
    return {
      getImageData: () => ({ width: this.width, height: this.height, data: this.pixels }),
      drawImage: (source, dx, dy) => {
        for (let y = 0; y < source.height; y++) for (let x = 0; x < source.width; x++) {
          const tx = x + dx, ty = y + dy;
          if (tx < 0 || ty < 0 || tx >= this.width || ty >= this.height) continue;
          this.pixels.set(source.pixels.subarray((y * source.width + x) * 4, (y * source.width + x + 1) * 4),
            (ty * this.width + tx) * 4);
        }
      },
    };
  }
}
function setup(t) {
  const document = globalThis.document, fetch = globalThis.fetch;
  globalThis.document = { createElement: () => new Canvas() };
  globalThis.fetch = () => { throw new Error("evaluation must not start inference"); };
  t.after(() => { globalThis.document = document; globalThis.fetch = fetch; });
  const canvas = new Canvas(32, 24); canvas.getContext();
  for (let y = 3; y < 21; y++) for (let x = 4; x < 20; x++) canvas.pixels.set([180, 60, 30, 255], (y * 32 + x) * 4);
  return { kind: "frames", w: 32, h: 24, fps: 8, frames: [{ canvas, duration: 130, index: 7 }] };
}
const def = nodeType("rtmCenter");
function prediction(fingerprint) {
  const points = Array(17).fill(null), scores = Array(17).fill(0);
  for (const [j, p] of [[5, [8, 7]], [6, [16, 7]], [11, [9, 17]], [12, [15, 17]]]) {
    points[j] = p; scores[j] = 0.9;
  }
  return { sourceFingerprint: fingerprint, width: 32, height: 24, keypoints: [points], scores: [scores],
    model: { name: "rtmpose-m_humanart_256x192" } };
}

test("the second scheme is a separately registered 主体居中RTM node", () => {
  assert.equal(def.title, "主体居中RTM");
  assert.equal(def.type, "rtmCenter");
});

test("RTM awaits explicit inference without altering images or timing", async t => {
  const src = setup(t), r = await def.evaluate(def.defaults(), { src });
  assert.equal(r.outputs.out.fps, 8);
  assert.deepEqual(r.outputs.out.frames.map(f => [f.index, f.duration]), [[7, 130]]);
  assert.deepEqual([...r.outputs.out.frames[0].canvas.pixels], [...src.frames[0].canvas.pixels]);
  assert.equal(r.view.centers[0], null);
  assert.equal(r.info.waiting, undefined);
});

test("saved RTM poses drive output pixels and centre-position changes reuse the same model predictions", async t => {
  const src = setup(t), fingerprint = await sequenceFingerprint(src), pose = prediction(fingerprint);
  const p = { ...def.defaults(), pose };
  const r = await def.evaluate(p, { src });
  assert.deepEqual(r.view.centers[0], { x: 12, y: 12 });
  const c = r.outputs.out.frames[0].canvas, offset = r.view.offsets[0];
  const pixel = ((12 + offset.dy) * c.width + 12 + offset.dx) * 4;
  assert.deepEqual([...c.pixels.subarray(pixel, pixel + 4)], [180, 60, 30, 255]);
  const changed = await def.evaluate({ ...p, centerRatio: 0.25 }, { src });
  assert.deepEqual(changed.view.centers[0], { x: 12, y: 9.5 });
  assert.deepEqual(p.pose, pose);
});

test("changing source content invalidates cached RTM predictions", async t => {
  const src = setup(t), r = await def.evaluate({ ...def.defaults(), pose: prediction("old") }, { src });
  assert.equal(r.info.stale, true);
  assert.equal(r.view.centers[0], null);
  assert.deepEqual(r.view.offsets[0], { dx: 0, dy: 0 });
});

test("clearing RTM poses cannot crash a preview before asynchronous evaluation catches up", async t => {
  const src = setup(t), fingerprint = await sequenceFingerprint(src);
  let params = { ...def.defaults(), pose: prediction(fingerprint) };
  const result = await def.evaluate(params, { src });
  class Element {
    nodeType = 1; style = {}; classList = { toggle() {} };
    setAttribute() {} addEventListener() {} append() {}
    getContext() { return new Proxy({}, { get: () => () => {} }); }
  }
  const raf = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = () => 1;
  t.after(() => { globalThis.requestAnimationFrame = raf; });
  globalThis.document = { createElement: () => new Element(), createTextNode: () => new Element() };
  const mounted = def.mount({ local: {}, tools: new Element(), body: new Element(),
    input: () => src, output: () => result.outputs.out, result: () => result, params: () => params });
  t.after(() => mounted.destroy());
  mounted.render();
  params = { ...params, pose: null };
  assert.doesNotThrow(() => mounted.render());
});
