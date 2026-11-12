import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
REVISION = "730cda1c730877cfedbe01bf87fb1cadb78a565d"
SOURCE = Path(os.environ.get("GUANGTAI_TAPNET_SOURCE", ROOT / ".models" / "tapnet"))
CHECKPOINT = Path(
    os.environ.get("GUANGTAI_TAPNEXT_CHECKPOINT", ROOT / ".models" / "tapnextpp_ckpt.pt")
)
RESOLUTION = 256
MAX_FRAMES = 512
MAX_POINTS = 16
MAX_PIXELS = 16 * 1024 * 1024
