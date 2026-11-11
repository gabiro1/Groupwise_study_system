"""Run the internal FastAPI service with Uvicorn."""

import os

import uvicorn


if __name__ == "__main__":
    uvicorn.run(
        "ml.recommendation.service:app",
        host=os.getenv("MODEL_SERVICE_HOST", "127.0.0.1"),
        port=int(os.getenv("MODEL_SERVICE_PORT", "8010")),
    )
