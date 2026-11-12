"""Independent RTMPose Human-Art inference; no TAPNext model is imported."""

import importlib.util
import os
import sys
from pathlib import Path

import numpy as np
from PIL import Image

from .config import MAX_FRAMES, MAX_PIXELS, ROOT

MODEL_NAME = "rtmpose-m_humanart_256x192"
MODEL_PATH = Path(os.environ.get("GUANGTAI_RTM_MODEL", ROOT / ".models/rtmpose/humanart-m.onnx"))
ARCHIVE_URL = (
    "https://download.openmmlab.com/mmpose/v1/projects/rtmposev1/onnx_sdk/"
    "rtmpose-m_8xb256-420e_humanart-256x192-8430627b_20230611.zip"
)
ARCHIVE_SHA256 = "e2b38e3a585d013eb2002259f8ca1b16543bf35ad499cf3b6ba4f2254294d8fe"


def environment_status():
    missing = [name for name in ("onnxruntime", "cv2") if importlib.util.find_spec(name) is None]
    return {"model": MODEL_NAME, "backend": "onnxruntime", "device": "cpu",
            "isolated": sys.prefix != sys.base_prefix,
            "missingDependencies": missing, "checkpointReady": MODEL_PATH.is_file(),
            "ready": not missing and MODEL_PATH.is_file()}


def roi_transform(bounds, padding=1.25):
    left, top, right, bottom = bounds
    center = np.array([(left + right) / 2, (top + bottom) / 2], dtype=np.float32)
    width, height = (right - left) * padding, (bottom - top) * padding
    width, height = max(width, height * 0.75), max(height, width / 0.75)
    scale = np.array([width, height], dtype=np.float32)
    factor = np.array([192, 256], dtype=np.float32) / scale
    matrix = np.array([[factor[0], 0, 96 - center[0] * factor[0]],
                       [0, factor[1], 128 - center[1] * factor[1]]], dtype=np.float32)
    return center, scale, matrix


def decode_simcc(simcc_x, simcc_y, center, scale):
    # Official MMPose SimCCLabel: no softmax, split ratio 2, min of axis maxima.
    x, y = np.asarray(simcc_x)[0], np.asarray(simcc_y)[0]
    if x.shape != (17, 384) or y.shape != (17, 512):
        raise RuntimeError("RTMPose 模型输出尺寸不符合 17 点 Human-Art 配置")
    locations = np.stack([x.argmax(axis=1), y.argmax(axis=1)], axis=1).astype(np.float32) / 2
    scores = np.minimum(x.max(axis=1), y.max(axis=1))
    points = locations / [192, 256] * scale + center - scale / 2
    return points, scores


class RTMPoseModel:
    def __init__(self):
        if not environment_status()["ready"]:
            raise RuntimeError("RTMPose 未准备好，请先运行 npm run rtm:setup")
        import cv2
        import onnxruntime as ort

        self._cv = cv2
        options = ort.SessionOptions()
        options.intra_op_num_threads = min(4, os.cpu_count() or 1)
        self._session = ort.InferenceSession(
            str(MODEL_PATH), sess_options=options, providers=["CPUExecutionProvider"]
        )
        self._input = self._session.get_inputs()[0].name

    def predict(self, rgba):
        alpha = np.asarray(rgba)[:, :, 3]
        count, _, stats, _ = self._cv.connectedComponentsWithStats(
            (alpha > 16).astype(np.uint8), connectivity=8
        )
        if count > 1:
            x, y, w, h, _ = stats[1:][stats[1:, 4].argmax()]
            bounds = [int(x), int(y), int(x + w), int(y + h)]
        else:
            ys, xs = np.nonzero(alpha)
            bounds = [int(xs.min()), int(ys.min()), int(xs.max() + 1), int(ys.max() + 1)]
        # This crop only sets inference resolution. Its centre is never used as
        # the animation centre; all output positions come from shoulder/hip joints.
        center, scale, matrix = roi_transform(bounds)
        background = Image.new("RGBA", rgba.size, (128, 128, 128, 255))
        rgb = np.asarray(Image.alpha_composite(background, rgba).convert("RGB"))
        image = self._cv.warpAffine(rgb, matrix, (192, 256), flags=self._cv.INTER_LINEAR)
        image = (image.astype(np.float32) - [123.675, 116.28, 103.53]) / [58.395, 57.12, 57.375]
        tensor = np.ascontiguousarray(image.transpose(2, 0, 1)[None], dtype=np.float32)
        x, y = self._session.run(["simcc_x", "simcc_y"], {self._input: tensor})
        points, scores = decode_simcc(x, y, center, scale)
        return points, scores, bounds


class RtmRunner:
    def __init__(self, loader=RTMPoseModel):
        self._loader, self._model = loader, None

    def estimate(self, request, progress=lambda done, total: None):
        paths, width, height = request.get("frames"), request.get("width"), request.get("height")
        if (type(width) is not int or type(height) is not int or width < 1 or height < 1
                or width * height > MAX_PIXELS):
            raise ValueError("画布尺寸无效")
        if (not isinstance(paths, list) or not 1 <= len(paths) <= MAX_FRAMES
                or any(not isinstance(p, str) for p in paths)):
            raise ValueError("请选择 1～512 帧")
        for path in paths:
            with Image.open(path) as image:
                if image.size != (width, height):
                    raise ValueError("所有帧的画布尺寸必须一致")
        keypoints, scores, foreground, rois = [], [], [], []
        for index, path in enumerate(paths):
            with Image.open(path) as image:
                rgba = image.convert("RGBA")
            alpha = np.asarray(rgba)[:, :, 3]
            if not alpha.any():
                keypoints.append([None] * 17)
                scores.append([0] * 17)
                foreground.append([False] * 17)
                rois.append(None)
            else:
                if self._model is None:
                    self._model = self._loader()
                points, confidence, roi = self._model.predict(rgba)
                points, confidence = np.asarray(points), np.asarray(confidence)
                if points.shape != (17, 2) or confidence.shape != (17,):
                    raise RuntimeError("RTMPose 返回的关键点数量不正确")
                frame_points, frame_scores, on_foreground = [], [], []
                for point, score in zip(points, confidence):
                    valid = np.isfinite(point).all() and np.isfinite(score)
                    frame_points.append(point.tolist() if valid else None)
                    frame_scores.append(float(score) if valid else 0)
                    inside = valid and 0 <= point[0] < width and 0 <= point[1] < height
                    if inside:
                        x, y = np.floor(point).astype(int)
                        patch = alpha[max(0, y - 2):min(height, y + 3),
                                      max(0, x - 2):min(width, x + 3)]
                        on_foreground.append(bool((patch > 8).any()))
                    else:
                        on_foreground.append(False)
                keypoints.append(frame_points)
                scores.append(frame_scores)
                foreground.append(on_foreground)
                rois.append(roi)
            progress(index + 1, len(paths))
        return {"width": width, "height": height, "keypoints": keypoints, "scores": scores,
                "foreground": foreground, "rois": rois,
                "model": {"name": MODEL_NAME, "backend": "onnxruntime", "device": "cpu"}}
