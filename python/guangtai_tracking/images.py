from pathlib import Path

import numpy as np
from PIL import Image

from .config import MAX_PIXELS


def frame_size(path: str | Path) -> tuple[int, int]:
    with Image.open(path) as image:
        if image.width * image.height > MAX_PIXELS:
            raise ValueError("图片尺寸过大")
        return image.size


def load_frame(path: str | Path, background=(128, 128, 128)) -> np.ndarray:
    """Composite a temporary RGB copy; never modify the source RGBA image."""
    with Image.open(path) as image:
        if image.width * image.height > MAX_PIXELS:
            raise ValueError("图片尺寸过大")
        rgba = image.convert("RGBA")
        base = Image.new("RGBA", rgba.size, (*background, 255))
        rgb = np.asarray(Image.alpha_composite(base, rgba).convert("RGB"))
        return np.ascontiguousarray(rgb[..., ::-1])
