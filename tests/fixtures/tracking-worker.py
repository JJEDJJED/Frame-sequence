"""Deterministic protocol fixture, never used by the application."""

import json
import sys
import time

for line in sys.stdin:
    request = json.loads(line)
    request_id = request["id"]
    if request["op"] == "status":
        result = {"model": "fixture", "ready": True}
    elif request["op"] == "sleep":
        time.sleep(2)
        result = {}
    else:
        if request["points"][0][0] == 13:
            print(json.dumps({"id": request_id, "type": "error", "error": "fixture failure"}), flush=True)
            continue
        result = {"tracks": [], "visibility": []}
        for index, _ in enumerate(request["frames"]):
            print(json.dumps({"id": request_id, "type": "progress", "done": index + 1,
                              "total": len(request["frames"])}), flush=True)
            result["tracks"].append(request["points"])
            result["visibility"].append([True] * len(request["points"]))
    print(json.dumps({"id": request_id, "type": "result", "result": result}), flush=True)
