FROM python:3.11-slim

WORKDIR /app

# Install system dependencies needed for numpy, scipy, xgboost
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc \
    g++ \
    libffi-dev \
    && rm -rf /var/lib/apt/lists/*

# Copy requirements first for better Docker layer caching
COPY backend/requirements.txt .

# Install Python dependencies
RUN pip install --no-cache-dir --upgrade pip && \
    pip install --no-cache-dir -r requirements.txt

# Copy the entire backend code
COPY backend/ .

# Railway provides PORT env variable
ENV PORT=8000

# Expose the port
EXPOSE 8000

# Start the app
CMD uvicorn main:app --host 0.0.0.0 --port ${PORT:-8000}
