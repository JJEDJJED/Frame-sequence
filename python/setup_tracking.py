"""Fetch pinned official inference sources and the standard 256 checkpoint."""

import hashlib
import json
import urllib.request
from pathlib import Path

from guangtai_tracking.config import CHECKPOINT, RESOLUTION, REVISION, SOURCE

FILES = [
    "LICENSE",
    "tapnet/tapnext/pscan.py",
    "tapnet/tapnext/tapnext_lru_modules.py",
    "tapnet/tapnext/tapnext_torch.py",
    "tapnet/tapnextpp/votsp2026/model.py",
    "tapnet/tapnextpp/votsp2026/utils.py",
]
CHECKPOINT_URL = "https://storage.googleapis.com/dm-tapnet/tapnextpp/tapnextpp_ckpt.pt"


def download(url: str, destination: Path):
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_suffix(destination.suffix + ".partial")
    try:
        with urllib.request.urlopen(url, timeout=60) as response, temporary.open("wb") as target:
            size = int(response.headers.get("Content-Length", 0))
            done, last_percent = 0, -1
            while block := response.read(1024 * 1024):
                target.write(block)
                done += len(block)
                percent = done * 100 // size if size else 0
                if size > 1024 * 1024 and percent // 10 != last_percent:
                    last_percent = percent // 10
                    print(f"{destination.name}: {percent}%", flush=True)
            if size and done != size:
                raise RuntimeError(f"下载不完整：{destination.name}")
        temporary.replace(destination)
    finally:
        temporary.unlink(missing_ok=True)


def main():
    revision_file = SOURCE / ".revision"
    current = revision_file.read_text().strip() if revision_file.is_file() else None
    for relative in FILES:
        destination = SOURCE / relative
        if current != REVISION or not destination.is_file():
            print(f"Fetching {relative}", flush=True)
            download(
                f"https://raw.githubusercontent.com/google-deepmind/tapnet/{REVISION}/{relative}",
                destination,
            )
    revision_file.write_text(REVISION + "\n")
    if not CHECKPOINT.is_file():
        download(CHECKPOINT_URL, CHECKPOINT)
    with CHECKPOINT.open("rb") as checkpoint_file:
        digest = hashlib.file_digest(checkpoint_file, "sha256").hexdigest()
    manifest = {
        "revision": REVISION,
        "checkpointUrl": CHECKPOINT_URL,
        "checkpointSha256": digest,
        "resolution": RESOLUTION,
    }
    CHECKPOINT.with_suffix(".json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"TAPNext++ ready. SHA256: {digest}", flush=True)


if __name__ == "__main__":
    main()
