import os

import numpy as np
import pytest
from guangtai_tracking.rtm import RtmRunner
from PIL import Image, ImageDraw


@pytest.mark.skipif(os.environ.get("GUANGTAI_RTM_TEST") != "1", reason="opt-in RTMPose model test")
def test_official_rtm_model_locates_torso_and_preserves_source_translation(tmp_path):
    image = Image.new("RGBA", (160, 144))
    draw = ImageDraw.Draw(image)
    draw.ellipse((57, 18, 81, 44), fill=(240, 190, 140, 255))
    draw.ellipse((56, 17, 82, 31), fill=(60, 40, 20, 255))
    draw.rectangle((64, 41, 74, 49), fill=(240, 190, 140, 255))
    draw.rectangle((52, 47, 86, 85), fill=(50, 100, 190, 255))
    draw.rectangle((43, 48, 51, 88), fill=(240, 190, 140, 255))
    draw.rectangle((87, 48, 95, 88), fill=(240, 190, 140, 255))
    draw.rectangle((53, 86, 65, 124), fill=(50, 60, 90, 255))
    draw.rectangle((73, 86, 85, 124), fill=(50, 60, 90, 255))
    paths = []
    for i, offset in enumerate([(0, 0), (17, 8)]):
        frame = Image.new("RGBA", image.size)
        frame.paste(image, offset)
        path = tmp_path / f"{i}.png"
        frame.save(path)
        paths.append(str(path))
    result = RtmRunner().estimate({"frames": paths, "width": 160, "height": 144})
    points = np.asarray(result["keypoints"])
    torso = [5, 6, 11, 12]
    assert points.shape == (2, 17, 2)
    assert np.isfinite(points).all()
    np.testing.assert_allclose(
        points[1, torso] - points[0, torso], np.tile([17, 8], (4, 1)), atol=1
    )
    center = points[0, torso].mean(axis=0)
    assert 52 <= center[0] <= 86 and 45 <= center[1] <= 86
    assert min(result["scores"][0][j] for j in torso) >= 0.15
    print({"torsoCenter": center.tolist(), "model": result["model"]})
