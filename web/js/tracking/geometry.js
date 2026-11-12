export const finitePoint = p => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite);
export const project = (t, p) => ({ x: t.a * p.x - t.b * p.y + t.tx, y: t.b * p.x + t.a * p.y + t.ty });

function fit(points) {
  const n = points.length, mean = key => points.reduce((s, p) => s + p[key], 0) / n;
  const rx = mean("rx"), ry = mean("ry"), x = mean("x"), y = mean("y");
  let denominator = 0, a = 0, b = 0;
  for (const p of points) {
    const u = p.rx - rx, v = p.ry - ry, dx = p.x - x, dy = p.y - y;
    denominator += u * u + v * v; a += u * dx + v * dy; b += u * dy - v * dx;
  }
  if (denominator < 0.25) return null;
  a /= denominator; b /= denominator;
  if (Math.hypot(a, b) < 0.25 || Math.hypot(a, b) > 4) return null;
  return { a, b, tx: x - a * rx + b * ry, ty: y - b * rx - a * ry };
}

// Pair consensus accepts rotation/scale. Bounding boxes never enter the fit.
export function fitTrackedTransform(tracking, index, width, height, opts = {}) {
  const refs = [...(tracking?.points || []), ...(tracking?.supportPoints || [])];
  const tracks = [...(tracking?.tracks?.[index] || []), ...(tracking?.supportTracks?.[index] || [])];
  const visible = [...(tracking?.visibility?.[index] || []), ...(tracking?.supportVisibility?.[index] || [])];
  const candidates = refs.flatMap((p, j) => finitePoint(p) && finitePoint(tracks[j]) && visible[j]
    && tracks[j][0] >= 0 && tracks[j][0] < width && tracks[j][1] >= 0 && tracks[j][1] < height
    ? [{ rx: p[0], ry: p[1], x: tracks[j][0], y: tracks[j][1], index: j }] : []);
  const required = Math.min(refs.length, Math.max(1, opts.minPoints || 2));
  if (!candidates.length || candidates.length < required) return null;
  if (candidates.length === 1) {
    const p = candidates[0];
    return { a: 1, b: 0, tx: p.x - p.rx, ty: p.y - p.ry, inliers: candidates, residual: 0, translationOnly: true };
  }
  const tolerance = Number.isFinite(opts.tolerance) ? Math.max(0.05, opts.tolerance) : 2;
  const minimum = Math.max(required, Math.floor(candidates.length / 2) + 1);
  const hypotheses = [fit(candidates)];
  for (let i = 0; i < candidates.length; i++) for (let j = i + 1; j < candidates.length; j++) {
    hypotheses.push(fit([candidates[i], candidates[j]]));
  }
  const error = (t, p) => {
    const q = project(t, { x: p.rx, y: p.ry });
    return Math.hypot(q.x - p.x, q.y - p.y);
  };
  let best = null;
  for (const t of hypotheses) {
    if (!t) continue;
    const inliers = candidates.filter(p => error(t, p) <= tolerance);
    if (inliers.length < minimum) continue;
    const refined = fit(inliers);
    if (!refined) continue;
    const accepted = candidates.filter(p => error(refined, p) <= tolerance);
    if (accepted.length < minimum) continue;
    const residual = accepted.reduce((sum, p) => sum + error(refined, p) ** 2, 0) / accepted.length;
    if (!best || accepted.length > best.inliers.length || accepted.length === best.inliers.length && residual < best.residual) {
      best = { ...refined, inliers: accepted, residual };
    }
  }
  // Local cloth/limb support can deform during an out-of-plane turn. If the
  // larger constellation cannot fit, independently consistent user queries can
  // still locate their chosen anchor; auxiliary points must not veto them.
  if (!best && tracking?.supportPoints?.length) {
    return fitTrackedTransform({ ...tracking, supportPoints: [], supportTracks: [], supportVisibility: [] },
      index, width, height, opts);
  }
  return best;
}
