FROM python:3.11-slim

WORKDIR /app

# Install system dependencies needed for numpy, scipy, xgboost, torch
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc \
    g++ \
    libffi-dev \
    && rm -rf /var/lib/apt/lists/*

# Copy requirements first for better Docker layer caching
COPY requirements.txt .

# Install Python dependencies.
# PyTorch is installed from the CPU-only wheel index to keep the image small
# (~200 MB torch vs 2+ GB CUDA torch). Railway standard plans have no GPU.
RUN pip install --no-cache-dir --upgrade pip && \
    pip install --no-cache-dir torch --index-url https://download.pytorch.org/whl/cpu && \
    pip install --no-cache-dir -r requirements.txt

# Copy the entire backend code
COPY . .

# Railway provides PORT env variable - use it
ENV PORT=8000

# Expose the port
EXPOSE 8000

# Start the app using shell form to read $PORT
CMD uvicorn main:app --host 0.0.0.0 --port ${PORT:-8000}
