export function trackingMatches(saved, fingerprint, points) {
  return !!saved && saved.sourceFingerprint === fingerprint
    && JSON.stringify(saved.points) === JSON.stringify(points);
}

export async function runTrackingJob(api, projectId, payload, {
  signal, onProgress, delay = () => new Promise(resolve => setTimeout(resolve, 400)),
} = {}) {
  const abortError = () => new DOMException("跟踪已取消", "AbortError");
  if (signal?.aborted) throw abortError();
  let jobId = null, cancelPromise = null, terminal = false;
  const cancel = () => {
    if (jobId && !cancelPromise) cancelPromise = api.cancelTracking(projectId, jobId).catch(() => {});
  };
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    const submitted = await api.startTracking(projectId, payload);
    jobId = submitted.id;
    while (true) {
      if (signal?.aborted) { cancel(); throw abortError(); }
      const job = await api.trackingJob(projectId, jobId);
      if (signal?.aborted) { cancel(); throw abortError(); }
      if (job.state === "completed") { terminal = true; return job.result; }
      if (job.state === "failed") { terminal = true; throw new Error(job.error || "跟踪失败"); }
      if (job.state === "cancelled") { terminal = true; throw abortError(); }
      onProgress?.(job);
      await delay();
    }
  } finally {
    signal?.removeEventListener("abort", cancel);
    if (!terminal) { cancel(); await cancelPromise; }
  }
}
