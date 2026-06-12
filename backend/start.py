"""Startup script for Railway — reads PORT from environment directly."""
import os
import sys

# Ensure the backend directory is in the Python path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import uvicorn

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8000))
    print(f"[A2Sniper] Starting server on 0.0.0.0:{port}...", flush=True)
    try:
        uvicorn.run("main:app", host="0.0.0.0", port=port, log_level="info")
    except Exception as e:
        print(f"[A2Sniper] FATAL ERROR: {e}", flush=True)
        raise
