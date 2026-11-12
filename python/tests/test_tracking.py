import io
import json

import numpy as np
import pytest
from guangtai_tracking.images import load_frame
from guangtai_tracking.runner import TrackingRunner
from guangtai_tracking.worker import serve
from PIL import Image


def png(tmp_path, name="frame.png", size=(8, 6), color=(200, 40, 20, 255)):
    path = tmp_path / name
    Image.new("RGBA", size, color).save(path)
    return str(path)


def test_transparent_rgb_is_composited_and_bgr_is_contiguous(tmp_path):
    path = tmp_path / "alpha.png"
    image = Image.new("RGBA", (3, 1))
    image.putdata([(255, 0, 0, 0), (255, 0, 0, 255), (255, 0, 0, 128)])
    image.save(path)
    frame = load_frame(path, background=(32, 64, 96))
    assert frame.tolist() == [[[96, 64, 32], [0, 0, 255], [48, 32, 144]]]
    assert frame.dtype == np.uint8
    assert frame.flags.c_contiguous


class FakeModel:
    def __init__(self):
        self.calls = []

    def track_frame(self, frame, query_points_xy=None, state=None):
        self.calls.append((frame.shape, query_points_xy, state))
        step = 0 if state is None else state
        points = np.array([[2 + step, 2], [4 + step, 3]], dtype=np.float32)
        return points, np.array([True, step == 0]), step + 1


def test_runner_reuses_model_but_resets_state_for_each_animation(tmp_path):
    model = FakeModel()
    loads = []
    runner = TrackingRunner(loader=lambda: loads.append(True) or model)
    request = {"frames": [png(tmp_path)] * 2, "points": [[2, 2], [4, 3]], "width": 8, "height": 6}
    progress = []
    result = runner.track(request, progress=lambda done, total: progress.append((done, total)))
    runner.track(request)
    assert len(loads) == 1
    assert [call[2] for call in model.calls] == [None, 1, None, 1]
    assert model.calls[0][1].tolist() == request["points"]
    assert model.calls[1][1] is None
    assert result["tracks"] == [[[2, 2], [4, 3]], [[3, 2], [5, 3]]]
    assert result["visibility"] == [[True, True], [True, False]]
    assert progress == [(1, 2), (2, 2)]


@pytest.mark.parametrize(
    "points", [[], [[-1, 2]], [[8, 2]], [[2, float("nan")]], [[True, 2]], [[2]]]
)
def test_rejects_invalid_queries_before_loading_model(tmp_path, points):
    loads = []
    runner = TrackingRunner(loader=lambda: loads.append(True))
    with pytest.raises(ValueError):
        runner.track({"frames": [png(tmp_path)], "points": points, "width": 8, "height": 6})
    assert not loads


def test_rejects_different_canvas_sizes_before_loading_model(tmp_path):
    loads = []
    runner = TrackingRunner(loader=lambda: loads.append(True))
    with pytest.raises(ValueError, match="尺寸"):
        runner.track(
            {
                "frames": [png(tmp_path), png(tmp_path, "other.png", (9, 6))],
                "points": [[2, 2]],
                "width": 8,
                "height": 6,
            }
        )
    assert not loads


def test_nonfinite_model_outputs_are_json_safe_and_not_visible(tmp_path):
    class InvalidModel:
        def track_frame(self, *args, **kwargs):
            return np.array([[np.nan, 2], [50, 3]]), np.array([True, True]), 1

    runner = TrackingRunner(loader=InvalidModel)
    result = runner.track(
        {"frames": [png(tmp_path)] * 2, "points": [[2, 2], [4, 3]], "width": 8, "height": 6}
    )
    assert result["visibility"][1] == [False, False]
    assert result["tracks"][1][0] is None
    json.dumps(result, allow_nan=False)


def test_worker_recovers_after_bad_request_without_polluting_jsonl():
    source = io.StringIO('bad json\n{"id":"a","op":"nope"}\n{"id":"b","op":"status"}\n')
    output = io.StringIO()
    serve(source, output)
    replies = [json.loads(line) for line in output.getvalue().splitlines()]
    assert len(replies) == 3
    assert replies[0]["type"] == "error"
    assert replies[1]["id"] == "a"
    assert replies[1]["type"] == "error"
    assert replies[2]["id"] == "b"
    assert replies[2]["type"] == "result"
    assert replies[2]["result"]["model"] == "tapnextpp"
