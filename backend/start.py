"""Startup script for Railway — reads PORT from environment directly."""
import os
import uvicorn

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8000))
    print(f"[A2Sniper] Starting on port {port}...")
    uvicorn.run("main:app", host="0.0.0.0", port=port, log_level="info")
