import { centerPlacement } from "./keypointAlign.js";

export const TORSO_JOINTS = [5, 6, 11, 12];
const midpoint = (a, b) => ({ x: (a[0] + b[0]) / 2, y: (a[1] + b[1]) / 2 });
const validPoint = (p, w, h) => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite)
  && p[0] >= 0 && p[0] < w && p[1] >= 0 && p[1] < h;

export function computeRtmAlignment(pose, opts = {}) {
  const width = opts.width ?? pose?.width, height = opts.height ?? pose?.height, subjects = opts.subjects;
  if (!Number.isInteger(width) || width < 1 || !Number.isInteger(height) || height < 1
      || !Array.isArray(subjects) || !subjects.length) throw new Error("RTM 输入画布尺寸无效");
  const threshold = Number.isFinite(opts.threshold) ? Math.max(0, Math.min(1, opts.threshold)) : 0.25;
  const torsos = subjects.map((s, i) => {
    if (!s.contentBounds) return { reason: "空帧" };
    const points = pose?.keypoints?.[i], scores = pose?.scores?.[i];
    if (!points || !scores) return { reason: "尚未识别" };
    const confidence = Math.min(...TORSO_JOINTS.map(j => Number.isFinite(scores[j]) ? scores[j] : 0));
    if (TORSO_JOINTS.some(j => !validPoint(points[j], width, height)
      || !Number.isFinite(scores[j]) || scores[j] < threshold)) return { confidence, reason: "肩或髋置信度不足" };
    if (pose.foreground?.[i] && TORSO_JOINTS.some(j => !pose.foreground[i][j])) return { confidence, reason: "躯干关键点落在透明区域" };
    const shoulder = midpoint(points[5], points[6]), hip = midpoint(points[11], points[12]);
    const v = { x: hip.x - shoulder.x, y: hip.y - shoulder.y };
    if (Math.hypot(v.x, v.y) < 2 || Math.hypot(v.x, v.y) > Math.hypot(width, height) * 0.8) {
      return { confidence, reason: "肩髋结构异常" };
    }
    return { shoulder, hip, v, confidence };
  });
  let ratio = Number.isFinite(opts.centerRatio) ? Math.max(0, Math.min(1, opts.centerRatio)) : 0.5;
  if (opts.anchor) {
    const a = opts.anchor, t = torsos[0];
    if (!t.v) throw new Error("首帧肩髋定位不可靠，无法应用中心标定，请检查首帧识别结果");
    if (!Number.isFinite(a.x) || !Number.isFinite(a.y) || a.x < 0 || a.x >= width || a.y < 0 || a.y >= height) {
      throw new Error("首帧标定中心需要在原图内");
    }
    // Calibrate height along the anatomical shoulder-to-hip axis. Lateral
    // screen offsets are deliberately not carried through a turn.
    ratio = ((a.x - t.shoulder.x) * t.v.x + (a.y - t.shoulder.y) * t.v.y) / (t.v.x ** 2 + t.v.y ** 2);
    if (ratio < -0.5 || ratio > 1.5) throw new Error("标定位置距离肩髋轴过远，请在躯干范围标定");
  }
  const centers = torsos.map(t => t.v ? { x: t.shoulder.x + t.v.x * ratio, y: t.shoulder.y + t.v.y * ratio } : null);
  const diagnostics = torsos.map((t, i) => ({ source: !subjects[i].contentBounds ? "empty" : centers[i] ? "pose" : "unavailable",
    confidence: t.confidence || 0, reason: t.reason || "", needsReview: !!subjects[i].contentBounds && !centers[i] }));
  const known = centers.flatMap((c, i) => c ? [i] : []), times = [0];
  subjects.forEach((_, i) => times.push(times[i] + (Number.isFinite(opts.durations?.[i]) && opts.durations[i] > 0 ? opts.durations[i] : 1)));
  centers.forEach((c, i) => {
    if (c || !known.length) return;
    const left = known.findLast(j => j < i), right = known.find(j => j > i);
    if (left !== undefined && right !== undefined) {
      const t = (times[i] - times[left]) / (times[right] - times[left]);
      centers[i] = { x: centers[left].x * (1 - t) + centers[right].x * t, y: centers[left].y * (1 - t) + centers[right].y * t };
      if (diagnostics[i].source !== "empty") diagnostics[i].source = "interpolated";
    } else {
      centers[i] = { ...centers[left ?? right] };
      if (diagnostics[i].source !== "empty") diagnostics[i].source = "held";
    }
  });
  const placement = centerPlacement(subjects, centers, width, height);
  return { ...placement, centers, torsos, diagnostics, centerRatio: ratio,
    fallbackFrames: diagnostics.flatMap((d, i) => ["interpolated", "held"].includes(d.source) ? [i] : []),
    reviewFrames: diagnostics.flatMap((d, i) => d.needsReview ? [i] : []),
    unavailableFrames: diagnostics.flatMap((d, i) => d.source === "unavailable" ? [i] : []),
    emptyFrames: diagnostics.flatMap((d, i) => d.source === "empty" ? [i] : []),
  };
}
