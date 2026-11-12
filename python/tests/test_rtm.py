import json

import numpy as np
import pytest
from guangtai_tracking.rtm import RtmRunner, decode_simcc, roi_transform
from PIL import Image


def test_roi_mapping_and_simcc_decode_restore_source_coordinates():
    center, scale, matrix = roi_transform([10, 20, 30, 60])
    np.testing.assert_allclose(center, [20, 40])
    np.testing.assert_allclose(scale, [37.5, 50])
    mapped = matrix @ [20, 40, 1]
    np.testing.assert_allclose(mapped, [96, 128])
    x, y = np.zeros((1, 17, 384)), np.zeros((1, 17, 512))
    x[:, :, 192] = 0.8
    y[:, :, 256] = 0.6
    points, scores = decode_simcc(x, y, center, scale)
    np.testing.assert_allclose(points, np.tile([20, 40], (17, 1)))
    np.testing.assert_allclose(scores, 0.6)  # Official MMPose decoder uses min(x peak, y peak).


class FakePose:
    def __init__(self):
        self.calls = 0

    def predict(self, rgba):
        self.calls += 1
        return np.tile([4.0, 3.0], (17, 1)), np.ones(17), [0, 0, 8, 6]


def test_rtm_reuses_model_preserves_rgba_and_returns_json_safe_predictions(tmp_path):
    path = tmp_path / "frame.png"
    Image.new("RGBA", (8, 6), (220, 40, 20, 200)).save(path)
    before = path.read_bytes()
    model = FakePose()
    loads = []
    runner = RtmRunner(loader=lambda: loads.append(True) or model)
    request = {"frames": [str(path)] * 2, "width": 8, "height": 6}
    progress = []
    result = runner.estimate(request, lambda done, total: progress.append((done, total)))
    runner.estimate(request)
    assert len(loads) == 1
    assert model.calls == 4
    assert result["keypoints"][0][5] == [4, 3]
    assert result["scores"][0][5] == 1
    assert result["foreground"][0][5]
    assert progress == [(1, 2), (2, 2)]
    assert path.read_bytes() == before
    json.dumps(result, allow_nan=False)


def test_empty_frames_do_not_load_a_model_or_hallucinate_a_skeleton(tmp_path):
    path = tmp_path / "empty.png"
    Image.new("RGBA", (8, 6)).save(path)
    runner = RtmRunner(loader=lambda: pytest.fail("empty input must not load the model"))
    result = runner.estimate({"frames": [str(path)], "width": 8, "height": 6})
    assert result["keypoints"][0] == [None] * 17
    assert result["scores"][0] == [0] * 17


def test_rtm_validates_all_frames_before_loading_the_model(tmp_path):
    path = tmp_path / "frame.png"
    Image.new("RGBA", (8, 6)).save(path)
    runner = RtmRunner(loader=lambda: pytest.fail("invalid request loaded the model"))
    for patch in ({"frames": []}, {"width": 9}, {"height": True}):
        with pytest.raises(ValueError):
            runner.estimate({"frames": [str(path)], "width": 8, "height": 6, **patch})
