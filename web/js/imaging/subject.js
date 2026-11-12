// Locate foreground outlines without changing pixels. Preservation bounds use
// alpha > 0; subject candidates use a stronger threshold to ignore faint glows.
export function analyzeSubjectFrame(image, { alphaThreshold = 16 } = {}) {
  const { width, height, data } = image;
  if (!Number.isInteger(width) || width < 1 || !Number.isInteger(height) || height < 1
      || width * height > 16 * 1024 * 1024 || data?.length !== width * height * 4) {
    throw new Error("主体分析的图片尺寸无效");
  }
  const threshold = Math.max(0, Math.min(255, Number(alphaThreshold) || 0));
  const n = width * height, visited = new Uint8Array(n), queue = new Int32Array(n);
  const components = [];
  let minX = width, minY = height, maxX = -1, maxY = -1, visiblePixels = 0;
  for (let i = 0; i < n; i++) {
    if (data[i * 4 + 3] > 0) {
      const x = i % width, y = Math.floor(i / width);
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y); visiblePixels++;
    }
    if (visited[i] || data[i * 4 + 3] <= threshold) continue;
    let head = 0, tail = 1, x0 = width, y0 = height, x1 = -1, y1 = -1;
    queue[0] = i; visited[i] = 1;
    while (head < tail) {
      const index = queue[head++], x = index % width, y = Math.floor(index / width);
      x0 = Math.min(x0, x); x1 = Math.max(x1, x);
      y0 = Math.min(y0, y); y1 = Math.max(y1, y);
      for (let ny = Math.max(0, y - 1); ny <= Math.min(height - 1, y + 1); ny++) {
        for (let nx = Math.max(0, x - 1); nx <= Math.min(width - 1, x + 1); nx++) {
          const neighbor = ny * width + nx;
          if (!visited[neighbor] && data[neighbor * 4 + 3] > threshold) {
            visited[neighbor] = 1; queue[tail++] = neighbor;
          }
        }
      }
    }
    components.push({ area: tail, bounds: { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 } });
  }
  const contentBounds = maxX < 0 ? null : { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
  components.sort((a, b) => b.area - a.area);
  const largest = components[0]?.area || 0;
  const minArea = largest >= 20 ? Math.max(3, Math.ceil(largest * 0.005)) : 1;
  const candidates = components.filter(c => c.area >= minArea);
  const lowAlpha = !candidates.length && !!contentBounds;
  if (lowAlpha) candidates.push({ area: visiblePixels, bounds: contentBounds });
  return { components: candidates, contentBounds, lowAlpha };
}
