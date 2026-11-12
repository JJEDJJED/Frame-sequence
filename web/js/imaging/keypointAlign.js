import { finitePoint, fitTrackedTransform, project } from "../tracking/geometry.js";

const pixelRound = x => (x < 0 ? -Math.round(-x) : Math.round(x)) || 0;
const boxValid = (b, w, h) => b && [b.x, b.y, b.w, b.h].every(Number.isFinite)
  && b.x >= 0 && b.y >= 0 && b.w > 0 && b.h > 0 && b.x + b.w <= w && b.y + b.h <= h;

function fitDimension(original, subjects, centers, axis) {
  const start = axis === "x" ? "x" : "y", length = axis === "x" ? "w" : "h";
  let extent = 0;
  subjects.forEach((s, i) => {
    const b = s.contentBounds, c = centers[i];
    if (b && c) extent = Math.max(extent, c[axis] - b[start], b[start] + b[length] - c[axis]);
  });
  let size = Math.max(original, Math.ceil(extent * 2));
  for (let pass = 0; pass < 2; pass++) {
    const clips = subjects.some((s, i) => {
      const b = s.contentBounds, c = centers[i], shift = c ? pixelRound(size / 2 - c[axis]) : 0;
      return b && (b[start] + shift < 0 || b[start] + b[length] + shift > size);
    });
    if (!clips) break;
    size++;
  }
  return size;
}

// Shared placement arithmetic; independent estimators provide their own centres.
export function centerPlacement(subjects, centers, width, height) {
  const outW = fitDimension(width, subjects, centers, "x"), outH = fitDimension(height, subjects, centers, "y");
  if (outW > 16384 || outH > 16384 || outW * outH > 64 * 1024 * 1024) throw new Error("居中后画布过大，请检查主体中心");
  const offsets = centers.map(c => c ? { dx: pixelRound(outW / 2 - c.x), dy: pixelRound(outH / 2 - c.y) } : { dx: 0, dy: 0 });
  return { outW, outH, offsets, target: { x: outW / 2, y: outH / 2 } };
}

export function computeKeypointAlignment(tracking, opts = {}) {
  const width = opts.width ?? tracking?.width, height = opts.height ?? tracking?.height, subjects = opts.subjects;
  if (!Number.isInteger(width) || width < 1 || !Number.isInteger(height) || height < 1
      || !Array.isArray(subjects) || !subjects.length || subjects.some(s => !s
        || !Array.isArray(s.components) || s.components.some(c => !boxValid(c.bounds, width, height)
          || !Number.isFinite(c.area) || c.area <= 0)
        || s.contentBounds !== null && !boxValid(s.contentBounds, width, height))) {
    throw new Error("主体轮廓或画布尺寸无效");
  }
  const manual = opts.subjectCenters || {};
  for (const [index, p] of Object.entries(manual)) {
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)
        || p.x < 0 || p.x > width || p.y < 0 || p.y > height) {
      throw new Error(`第 ${Number(index) + 1} 帧的主体中心不在画布内`);
    }
  }
  // First query = requested centre. Other points estimate its motion under
  // rotation; a manual first-frame centre can define a virtual pivot instead.
  const anchor = manual[0] || (finitePoint(tracking?.points?.[0])
    ? { x: tracking.points[0][0], y: tracking.points[0][1] } : null);
  const diagnostics = [], centers = [], times = [0];
  subjects.forEach((s, i) => {
    const transform = s.contentBounds ? fitTrackedTransform(tracking, i, width, height, opts) : null;
    const center = manual[i] ? { ...manual[i] } : anchor && transform ? project(transform, anchor) : null;
    centers.push(center);
    const empty = !s.contentBounds;
    diagnostics.push({ source: manual[i] ? "manual" : empty ? "empty" : center ? "tracking" : "untracked",
      reliablePoints: transform?.inliers.length || 0, needsReview: !empty && !center,
      translationOnly: !!transform?.translationOnly, lowAlpha: !!s.lowAlpha,
      inlierIndices: transform?.inliers.map(p => p.index) || [] });
    const duration = opts.durations?.[i];
    times.push(times[i] + (Number.isFinite(duration) && duration > 0 ? duration : 1));
  });
  const reliable = centers.flatMap((c, i) => c ? [i] : []);
  centers.forEach((center, i) => {
    if (center || !reliable.length) return;
    const left = reliable.findLast(j => j < i), right = reliable.find(j => j > i);
    if (left !== undefined && right !== undefined) {
      const t = (times[i] - times[left]) / (times[right] - times[left]);
      centers[i] = { x: centers[left].x * (1 - t) + centers[right].x * t,
        y: centers[left].y * (1 - t) + centers[right].y * t };
      if (diagnostics[i].source !== "empty") diagnostics[i].source = "interpolated";
    } else {
      centers[i] = { ...centers[left ?? right] };
      if (diagnostics[i].source !== "empty") diagnostics[i].source = "held";
    }
  });
  const { outW, outH, offsets, target } = centerPlacement(subjects, centers, width, height);
  // Outlines are diagnostic only: their centres never determine an offset.
  const subjectBounds = subjects.map((s, i) => {
    const c = centers[i];
    return (c && s.components.find(p => c.x >= p.bounds.x && c.x < p.bounds.x + p.bounds.w
      && c.y >= p.bounds.y && c.y < p.bounds.y + p.bounds.h) || s.components[0])?.bounds || null;
  });
  return { centers, subjectBounds, diagnostics, offsets, rawOffsets: offsets, outW, outH,
    target,
    fallbackFrames: diagnostics.flatMap((d, i) => ["interpolated", "held"].includes(d.source) ? [i] : []),
    emptyFrames: diagnostics.flatMap((d, i) => d.source === "empty" ? [i] : []),
    reviewFrames: diagnostics.flatMap((d, i) => d.needsReview ? [i] : []),
    untrackedFrames: diagnostics.flatMap((d, i) => d.source === "untracked" ? [i] : []),
  };
}
