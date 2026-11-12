import json
import os

import numpy as np
import pytest
from guangtai_tracking.runner import TrackingRunner
from PIL import Image, ImageDraw


@pytest.mark.skipif(os.environ.get("GUANGTAI_MODEL_TEST") != "1", reason="opt-in real model test")
def test_model_tracks_translated_pixel_character(tmp_path):
    character = Image.new("RGBA", (64, 64))
    draw = ImageDraw.Draw(character)
    draw.rectangle((25, 8, 38, 20), fill=(240, 190, 130, 255))
    draw.rectangle((22, 21, 41, 43), fill=(50, 110, 190, 255))
    draw.rectangle((16, 23, 21, 40), fill=(200, 150, 100, 255))
    draw.rectangle((42, 23, 47, 40), fill=(200, 150, 100, 255))
    draw.rectangle((23, 44, 29, 57), fill=(50, 60, 90, 255))
    draw.rectangle((34, 44, 40, 57), fill=(50, 60, 90, 255))
    rng = np.random.default_rng(42)
    for y in range(22, 43, 2):
        for x in range(23, 41, 2):
            color = tuple(int(v) for v in rng.integers(30, 240, size=3)) + (255,)
            draw.rectangle((x, y, x + 1, y + 1), fill=color)
    points = [[27, 28], [35, 28], [31, 36]]
    movements = [(0, 0), (1, 0), (2, -1), (3, -2), (1, -1), (0, 0)]
    frames = []
    for index, offset in enumerate(movements):
        frame = Image.new("RGBA", character.size)
        frame.paste(character, offset)
        filename = tmp_path / f"frame_{index:02}.png"
        frame.save(filename)
        frames.append(str(filename))
    result = TrackingRunner().track({"frames": frames, "points": points, "width": 64, "height": 64})
    predicted = np.asarray(result["tracks"])
    expected = np.asarray(points)[None] + np.asarray(movements)[:, None]
    errors = np.linalg.norm(predicted - expected, axis=2)
    report = {
        "result": result,
        "expected": expected.tolist(),
        "meanError": float(errors.mean()),
        "maxError": float(errors.max()),
    }
    (tmp_path / "result.json").write_text(json.dumps(report, indent=2))
    print(json.dumps({key: report[key] for key in ("meanError", "maxError")}))
    assert predicted.shape == (6, 3, 2)
    assert np.isfinite(predicted).all()
    assert np.asarray(result["visibility"]).mean() >= 0.8
    assert errors.mean() < 3
    assert errors.max() < 6


@pytest.mark.skipif(os.environ.get("GUANGTAI_MODEL_TEST") != "1", reason="opt-in real model test")
def test_model_tracks_a_known_pivot_through_rotation(tmp_path):
    character = Image.new("RGBA", (128, 128))
    draw = ImageDraw.Draw(character)
    draw.rectangle((57, 30, 71, 43), fill=(240, 190, 130, 255))
    draw.rectangle((50, 44, 78, 83), fill=(40, 90, 180, 255))
    draw.rectangle((44, 46, 49, 79), fill=(200, 130, 90, 255))
    draw.rectangle((79, 46, 84, 79), fill=(200, 130, 90, 255))
    draw.rectangle((51, 84, 60, 102), fill=(40, 50, 80, 255))
    draw.rectangle((68, 84, 77, 102), fill=(40, 50, 80, 255))
    rng = np.random.default_rng(17)
    for y in range(46, 82, 2):
        for x in range(52, 78, 2):
            color = tuple(int(v) for v in rng.integers(30, 240, size=3)) + (255,)
            draw.rectangle((x, y, x + 1, y + 1), fill=color)
    frames, expected = [], []
    for i, angle in enumerate(range(0, 181, 15)):
        rotated = character.rotate(angle, resample=Image.Resampling.NEAREST, center=(64, 64))
        frame = Image.new("RGBA", character.size)
        dx, dy = i, -(i // 3)
        frame.paste(rotated, (dx, dy))
        filename = tmp_path / f"rotate_{i:02}.png"
        frame.save(filename)
        frames.append(str(filename))
        expected.append([64 + dx, 64 + dy])
    result = TrackingRunner().track({
        "frames": frames, "points": [[64, 64]], "width": 128, "height": 128,
    })
    predicted = np.asarray(result["tracks"])[:, 0]
    usable = np.asarray(result["visibility"])[:, 0]
    errors = np.linalg.norm(predicted - expected, axis=1)
    report = {"result": result, "expected": expected,
              "meanError": float(errors[usable].mean()), "maxError": float(errors[usable].max()),
              "usableFrames": int(usable.sum())}
    (tmp_path / "rotation-result.json").write_text(json.dumps(report))
    print(json.dumps({key: report[key] for key in ("meanError", "maxError", "usableFrames")}))
    assert usable.mean() >= 0.8
    assert errors[usable].mean() < 3
    assert errors[usable].max() < 6
