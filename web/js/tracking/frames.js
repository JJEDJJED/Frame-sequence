import { canvasToBlob } from "../core/util.js";
import { analyzeSubjectFrame } from "../imaging/subject.js";

const signatures = new WeakMap();
const outlines = new WeakMap();
const hex = bytes => [...new Uint8Array(bytes)].map(v => v.toString(16).padStart(2, "0")).join("");

export function sequenceSubjects(src, alphaThreshold = 16) {
  let cached = outlines.get(src);
  if (!cached) { cached = new Map(); outlines.set(src, cached); }
  const threshold = Number.isFinite(alphaThreshold) ? Math.max(0, Math.min(255, alphaThreshold)) : 16;
  if (!cached.has(threshold)) {
    cached.set(threshold, src.frames.map(frame => {
      if (frame.canvas.width !== src.w || frame.canvas.height !== src.h) throw new Error("输入帧尺寸不一致");
      return analyzeSubjectFrame(frame.canvas.getContext("2d", { willReadFrequently: true })
        .getImageData(0, 0, src.w, src.h), { alphaThreshold: threshold });
    }));
  }
  return cached.get(threshold);
}

export function sequenceFingerprint(src) {
  let pending = signatures.get(src);
  if (!pending) {
    pending = (async () => {
      const hashes = [];
      for (const frame of src.frames) {
        if (frame.canvas.width !== src.w || frame.canvas.height !== src.h) throw new Error("输入帧尺寸不一致");
        const rgba = frame.canvas.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, src.w, src.h).data;
        hashes.push(hex(await crypto.subtle.digest("SHA-256", rgba)));
      }
      return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${src.w}x${src.h}:${hashes.join(":")}`)));
    })();
    signatures.set(src, pending);
    pending.catch(() => signatures.delete(src));
  }
  return pending;
}

export async function uploadSequence(src, projectId, api, signal, onProgress) {
  const assetIds = [];
  for (let i = 0; i < src.frames.length; i++) {
    if (signal?.aborted) throw new DOMException("跟踪已取消", "AbortError");
    assetIds.push(await api.uploadAsset(projectId, await canvasToBlob(src.frames[i].canvas)));
    onProgress?.(i + 1, src.frames.length);
  }
  return assetIds;
}
