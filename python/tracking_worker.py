from guangtai_tracking.worker import serve

if __name__ == "__main__":
    import sys

    sys.stdin.reconfigure(encoding="utf-8")
    sys.stdout.reconfigure(encoding="utf-8")
    serve()
