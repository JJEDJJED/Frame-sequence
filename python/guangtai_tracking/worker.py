import contextlib
import json
import sys

from .runner import TrackingRunner, environment_status


def serve(
    source=sys.stdin, output=sys.stdout, runner=None, status=environment_status, operation="track"
):
    runner = runner or TrackingRunner()

    def emit(message):
        output.write(json.dumps(message, ensure_ascii=False, allow_nan=False) + "\n")
        output.flush()

    for line in source:
        request_id = None
        try:
            request = json.loads(line)
            if not isinstance(request, dict):
                raise ValueError("请求必须是 JSON 对象")
            request_id = request.get("id")
            op = request.get("op")
            # Upstream libraries may print during import/inference. stdout is only JSONL.
            with contextlib.redirect_stdout(sys.stderr):
                if op == "status":
                    result = status()
                elif op == operation:
                    run = runner.track if operation == "track" else runner.estimate
                    result = run(
                        request,
                        progress=lambda done, total: emit(
                            {
                                "id": request_id,
                                "type": "progress",
                                "done": done,
                                "total": total,
                            }
                        ),
                    )
                else:
                    raise ValueError("未知操作")
            emit({"id": request_id, "type": "result", "result": result})
        except Exception as error:
            emit({"id": request_id, "type": "error", "error": str(error)})


if __name__ == "__main__":
    sys.stdin.reconfigure(encoding="utf-8")
    sys.stdout.reconfigure(encoding="utf-8")
    serve()
