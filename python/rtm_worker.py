import sys

from guangtai_tracking.rtm import RtmRunner, environment_status
from guangtai_tracking.worker import serve

if __name__ == "__main__":
    sys.stdin.reconfigure(encoding="utf-8")
    sys.stdout.reconfigure(encoding="utf-8")
    serve(runner=RtmRunner(), status=environment_status, operation="estimate")
