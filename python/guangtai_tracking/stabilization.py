"""Local support queries and independent reverse/cycle validation of point tracks."""

import numpy as np
from PIL import Image


def support_queries(path, points, limit=12):
    with Image.open(path) as image:
        alpha = np.asarray(image.convert("RGBA"))[:, :, 3]
    height, width = alpha.shape
    selected = np.asarray(points, dtype=float)
    center = selected.mean(axis=0)
    radius = max(12, min(24, float(np.ptp(selected, axis=0).max()) * 0.75))
    candidates = []
    for dy in np.linspace(-radius, radius, 7):
        for dx in np.linspace(-radius, radius, 7):
            x, y = np.rint(center + [dx, dy]).astype(int)
            if (dx * dx + dy * dy <= radius * radius
                    and 0 <= x < width and 0 <= y < height and alpha[y, x] >= 128):
                candidates.append([int(x), int(y)])
    supports = []
    while candidates and len(supports) < limit:
        distances = [float(np.linalg.norm(selected - p, axis=1).min()) for p in candidates]
        index = int(np.argmax(distances))
        if distances[index] < 3:
            break
        point = candidates.pop(index)
        supports.append(point)
        selected = np.vstack([selected, point])
    return supports


def foreground_points(path, points, radius=2):
    with Image.open(path) as image:
        alpha = np.asarray(image.convert("RGBA"))[:, :, 3]
    height, width = alpha.shape
    result = []
    for point in points:
        if not np.isfinite(point).all() or not (0 <= point[0] < width and 0 <= point[1] < height):
            result.append(False)
            continue
        x, y = np.floor(point).astype(int)
        patch = alpha[max(0, y - radius):min(height, y + radius + 1),
                      max(0, x - radius):min(width, x + radius + 1)]
        result.append(bool((patch > 8).any()))
    return np.asarray(result, dtype=bool)


def fuse_bidirectional(forward, visible, backward, backward_visible, foreground, tolerance=3):
    forward, backward = np.asarray(forward), np.asarray(backward)
    raw = np.asarray(visible, dtype=bool)
    usable = raw.copy() & foreground & np.isfinite(forward).all(axis=2)
    fused = forward.copy()
    status = np.where(usable, "tracked", "lost").astype(object)
    cycle = np.linalg.norm(backward[0] - forward[0], axis=1) <= tolerance
    agreement = np.linalg.norm(forward - backward, axis=2) <= tolerance
    reverse_valid = np.isfinite(backward).all(axis=2) & cycle[None, :]
    # Foreground alone is insufficient. The reverse path must return to the
    # known first-frame query and agree with the forward path on this frame.
    recover = ~raw & agreement & reverse_valid & foreground
    confirm = usable & agreement & reverse_valid & backward_visible
    conflict = usable & reverse_valid & backward_visible & ~agreement
    usable[conflict] = False
    status[conflict] = "lost"
    usable[recover] = True
    fused[recover | confirm] = (forward[recover | confirm] + backward[recover | confirm]) / 2
    status[recover] = "recovered"
    status[confirm] = "confirmed"
    fused[0] = forward[0]
    usable[0] = raw[0] & foreground[0]
    status[0] = np.where(usable[0], "reference", "lost")
    return fused, usable, status.tolist()
