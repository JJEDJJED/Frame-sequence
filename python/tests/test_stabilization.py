import numpy as np
from guangtai_tracking.runner import TrackingRunner
from guangtai_tracking.stabilization import fuse_bidirectional, support_queries
from PIL import Image


def test_runner_adds_support_and_recovers_a_point_from_an_independent_reverse_pass(tmp_path):
    class DirectionalModel:
        def __init__(self):
            self.streams = 0

        def track_frame(self, frame, query_points_xy=None, state=None):
            index = int(frame[0, 0, 0])
            if state is None:
                self.streams += 1
                state = (np.asarray(query_points_xy) - [index, 0], self.streams)
            base, stream = state
            visible = np.ones(len(base), dtype=bool)
            if stream == 1 and index == 1:
                visible[0] = False
            return base + [index, 0], visible, state

    frames = []
    for i in range(3):
        path = tmp_path / f"{i}.png"
        Image.new("RGBA", (64, 64), (i, i, i, 255)).save(path)
        frames.append(str(path))
    model = DirectionalModel()
    result = TrackingRunner(loader=lambda: model).track({
        "frames": frames, "points": [[30, 30]], "width": 64, "height": 64,
    })
    assert model.streams == 2
    assert len(result["supportPoints"]) >= 4
    assert len(result["tracks"][0]) == 1
    assert result["tracks"][1] == [[31, 30]]
    assert result["modelVisibility"][1] == [False]
    assert result["visibility"][1] == [True]
    assert result["pointStatus"][1] == ["recovered"]
    assert result["model"]["stabilizationVersion"] == 1


def test_support_queries_are_spread_over_local_foreground_without_changing_user_anchors(tmp_path):
    path = tmp_path / "body.png"
    image = Image.new("RGBA", (64, 64))
    image.paste((80, 150, 200, 255), (15, 15, 46, 46))
    image.save(path)
    points = [[30, 30], [31, 32]]
    supports = support_queries(str(path), points)
    assert 4 <= len(supports) <= 12
    assert points == [[30, 30], [31, 32]]
    assert all(image.getpixel(tuple(map(round, p)))[3] > 0 for p in supports)
    assert max(np.linalg.norm(np.asarray(p) - points[0]) for p in supports) >= 8


def test_reverse_confirmation_recovers_low_visibility_without_hiding_raw_model_flags():
    forward = np.array([[[10, 10]], [[12, 10]], [[14, 10]]], dtype=float)
    backward = forward.copy()
    visible = np.array([[True], [False], [True]])
    fused, usable, status = fuse_bidirectional(
        forward, visible, backward, np.ones((3, 1), dtype=bool),
        np.ones((3, 1), dtype=bool), tolerance=2,
    )
    assert usable[:, 0].tolist() == [True, True, True]
    assert status[1][0] == "recovered"
    assert not visible[1, 0]
    np.testing.assert_allclose(fused, forward)


def test_consistent_low_visibility_in_both_directions_requires_cycle_and_foreground_evidence():
    forward = np.array([[[10, 10]], [[12, 10]], [[14, 10]]], dtype=float)
    visible = np.array([[True], [False], [True]])
    foreground = np.ones((3, 1), dtype=bool)
    _, usable, _ = fuse_bidirectional(forward, visible, forward.copy(), visible, foreground)
    assert usable[1, 0]
    foreground[1, 0] = False
    _, usable, _ = fuse_bidirectional(forward, visible, forward.copy(), visible, foreground)
    assert not usable[1, 0]


def test_bad_reverse_cycle_or_disagreement_does_not_promote_an_occluded_point():
    forward = np.array([[[10, 10]], [[12, 10]], [[14, 10]]], dtype=float)
    visible = np.array([[True], [False], [True]])
    backward = forward.copy()
    backward[0, 0] += 10
    _, usable, status = fuse_bidirectional(
        forward, visible, backward, np.ones((3, 1), dtype=bool), np.ones((3, 1), dtype=bool),
    )
    assert not usable[1, 0]
    assert status[1][0] == "lost"
    backward = forward.copy()
    backward[1, 0] += 10
    _, usable, _ = fuse_bidirectional(
        forward, visible, backward, np.ones((3, 1), dtype=bool), np.ones((3, 1), dtype=bool),
    )
    assert not usable[1, 0]
