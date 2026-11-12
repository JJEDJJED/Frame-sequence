import importlib.util
import sys

import numpy as np

from .config import CHECKPOINT, MAX_FRAMES, MAX_PIXELS, MAX_POINTS, RESOLUTION, REVISION, SOURCE
from .images import frame_size, load_frame
from .stabilization import foreground_points, fuse_bidirectional, support_queries


def environment_status():
    missing = [
        name
        for name in ("torch", "torchvision", "einops")
        if importlib.util.find_spec(name) is None
    ]
    source_ready = (SOURCE / "tapnet/tapnextpp/votsp2026/model.py").is_file()
    return {
        "model": "tapnextpp",
        "revision": REVISION,
        "resolution": RESOLUTION,
        "python": sys.version.split()[0],
        "isolated": sys.prefix != sys.base_prefix,
        "missingDependencies": missing,
        "sourceReady": source_ready,
        "checkpointReady": CHECKPOINT.is_file(),
        "ready": not missing and source_ready and CHECKPOINT.is_file(),
        "stabilizationVersion": 1,
    }


def load_model():
    status = environment_status()
    if not status["ready"]:
        raise RuntimeError("跟踪模型未准备好，请先运行 npm run tracking:setup")
    sys.path.insert(0, str(SOURCE))
    import torch
    from tapnet.tapnextpp.votsp2026.model import TAPNextPP

    device = "cuda" if torch.cuda.is_available() else "cpu"
    return TAPNextPP.from_checkpoint(
        CHECKPOINT, device=device, input_resolution=RESOLUTION, compile_model=False
    )


class TrackingRunner:
    def __init__(self, loader=load_model):
        self._loader = loader
        self._model = None

    def track(self, request, progress=lambda done, total: None):
        paths, points = request.get("frames"), request.get("points")
        width, height = request.get("width"), request.get("height")
        if not isinstance(paths, list) or not 1 <= len(paths) <= MAX_FRAMES:
            raise ValueError(f"帧数需要在 1～{MAX_FRAMES} 之间")
        if (
            type(width) is not int
            or type(height) is not int
            or width < 1
            or height < 1
            or width * height > MAX_PIXELS
        ):
            raise ValueError("画布尺寸无效")
        if not isinstance(points, list) or not 1 <= len(points) <= MAX_POINTS:
            raise ValueError(f"请选择 1～{MAX_POINTS} 个参考点")
        for point in points:
            if (
                not isinstance(point, list)
                or len(point) != 2
                or any(type(v) not in (int, float) or not np.isfinite(v) for v in point)
                or not (0 <= point[0] < width and 0 <= point[1] < height)
            ):
                raise ValueError("参考点需要是画布内的有限 x、y 坐标")
        # Validate all headers before expensive model loading; decode only one frame at a time.
        for path in paths:
            if not isinstance(path, str) or frame_size(path) != (width, height):
                raise ValueError("所有帧的画布尺寸必须一致")
        if self._model is None:
            self._model = self._loader()
        enhanced = len(paths) >= 3
        supports = support_queries(paths[0], points) if enhanced else []
        query = np.asarray(points + supports, dtype=np.float32)
        count = len(query)
        tracks, visibility = [], []
        state = None
        for index, path in enumerate(paths):
            frame = load_frame(path)
            if index == 0:
                positions, visible, state = self._model.track_frame(frame, query)
                # The reference frame is exactly the user's chosen anchor.
                positions, visible = query, np.ones(count, dtype=bool)
            else:
                positions, visible, state = self._model.track_frame(frame, state=state)
            positions, visible = np.asarray(positions), np.asarray(visible)
            if positions.shape != (count, 2) or visible.shape != (count,):
                raise RuntimeError("模型返回的跟踪点数量不一致")
            valid = np.isfinite(positions).all(axis=1)
            in_bounds = (
                (positions[:, 0] >= 0)
                & (positions[:, 0] < width)
                & (positions[:, 1] >= 0)
                & (positions[:, 1] < height)
            )
            tracks.append(positions.copy())
            visibility.append((visible.astype(bool) & valid & in_bounds).tolist())
            progress((index + 1) // 2 if enhanced else index + 1, len(paths))
        forward = np.asarray(tracks, dtype=float)
        raw_visibility = np.asarray(visibility, dtype=bool)
        foreground = np.stack([foreground_points(p, xy) for p, xy in zip(paths, forward)])
        fused, usable, point_status = fuse_bidirectional(
            forward, raw_visibility, np.full_like(forward, np.nan),
            np.zeros_like(raw_visibility), foreground
        )
        if enhanced:
            usable_seeds = raw_visibility & foreground
            minimum = max(1, min(2, count))
            eligible = np.flatnonzero(usable_seeds.sum(axis=1) >= minimum)
            anchors = [0]
            for index in eligible:
                if index - anchors[-1] >= 4:
                    anchors.append(int(index))
            if len(eligible) and eligible[-1] > anchors[-1]:
                anchors.append(int(eligible[-1]))
            reverse_total = sum(end - start + 1 for start, end in zip(anchors, anchors[1:]))
            reverse_done = 0
            for start, end in zip(anchors, anchors[1:]):
                indices = np.flatnonzero(usable_seeds[end] & usable_seeds[start])
                if not len(indices):
                    reverse_done += end - start + 1
                    continue
                backward = np.full_like(forward[start:end + 1], np.nan)
                backward_visible = np.zeros_like(raw_visibility[start:end + 1])
                reverse_state = None
                seed = forward[end, indices].astype(np.float32)
                for index in range(end, start - 1, -1):
                    frame = load_frame(paths[index])
                    if index == end:
                        _, _, reverse_state = self._model.track_frame(frame, seed)
                        positions, visible = seed, np.ones(len(indices), dtype=bool)
                    else:
                        positions, visible, reverse_state = self._model.track_frame(
                            frame, state=reverse_state
                        )
                    positions, visible = np.asarray(positions), np.asarray(visible)
                    if positions.shape != (len(indices), 2) or visible.shape != (len(indices),):
                        raise RuntimeError("反向模型返回的跟踪点数量不一致")
                    backward[index - start, indices] = positions
                    on_foreground = foreground_points(paths[index], positions)
                    backward_visible[index - start, indices] = visible.astype(bool) & on_foreground
                    reverse_done += 1
                    progress(len(paths) // 2 + reverse_done * (len(paths) - len(paths) // 2)
                             // reverse_total, len(paths))
                segment, accepted, statuses = fuse_bidirectional(
                    forward[start:end + 1], raw_visibility[start:end + 1],
                    backward, backward_visible, foreground[start:end + 1]
                )
                fused[start + 1:end + 1] = segment[1:]
                usable[start + 1:end + 1] = accepted[1:]
                point_status[start + 1:end + 1] = statuses[1:]

        def serial_positions(values):
            return [
                [p.tolist() if np.isfinite(p).all() else None for p in frame] for frame in values
            ]

        if enhanced:
            progress(len(paths), len(paths))
        device = str(getattr(self._model, "device", "test"))
        return {
            "width": width,
            "height": height,
            "points": points,
            "tracks": serial_positions(fused[:, :len(points)]),
            "visibility": usable[:, :len(points)].tolist(),
            "modelVisibility": raw_visibility[:, :len(points)].tolist(),
            "pointStatus": [frame[:len(points)] for frame in point_status],
            "supportPoints": supports,
            "supportTracks": serial_positions(fused[:, len(points):]),
            "supportVisibility": usable[:, len(points):].tolist(),
            "supportStatus": [frame[len(points):] for frame in point_status],
            "model": {
                "name": "tapnextpp",
                "revision": REVISION,
                "resolution": RESOLUTION,
                "device": device,
                "stabilizationVersion": 1,
                "supportPointCount": len(supports),
            },
        }
