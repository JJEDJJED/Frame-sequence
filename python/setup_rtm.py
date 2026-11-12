"""Install a checksum-pinned official ONNX model without extracting arbitrary ZIP paths."""

import hashlib
import json
import urllib.request
import zipfile

from guangtai_tracking.rtm import ARCHIVE_SHA256, ARCHIVE_URL, MODEL_PATH


def setup():
    folder = MODEL_PATH.parent
    folder.mkdir(parents=True, exist_ok=True)
    archive = folder / "humanart-m.zip"
    def digest(p):
        return hashlib.sha256(p.read_bytes()).hexdigest()

    if not archive.is_file() or digest(archive) != ARCHIVE_SHA256:
        temporary = archive.with_suffix(".download")
        urllib.request.urlretrieve(ARCHIVE_URL, temporary)
        if digest(temporary) != ARCHIVE_SHA256:
            raise RuntimeError("RTMPose 官方模型压缩包校验失败")
        temporary.replace(archive)
    with zipfile.ZipFile(archive) as source:
        names = [name for name in source.namelist() if name.endswith("/end2end.onnx")]
        if len(names) != 1:
            raise RuntimeError("RTMPose 模型包内容不符合预期")
        temporary = MODEL_PATH.with_suffix(".download")
        temporary.write_bytes(source.read(names[0]))
        temporary.replace(MODEL_PATH)
        for basename in ("pipeline.json", "deploy.json", "detail.json"):
            name = names[0].rsplit("/", 1)[0] + "/" + basename
            (folder / basename).write_bytes(source.read(name))
    metadata = {"source": ARCHIVE_URL, "archiveSHA256": ARCHIVE_SHA256,
                "modelSHA256": digest(MODEL_PATH)}
    (folder / "provenance.json").write_text(json.dumps(metadata, indent=2), encoding="utf-8")
    print(json.dumps({"model": str(MODEL_PATH), **metadata}))


if __name__ == "__main__":
    setup()
