"""Internal, score-only FastAPI model service."""

import hmac
import os
from typing import Annotated

from fastapi import Depends, FastAPI, HTTPException, Request, status
from fastapi.security import APIKeyHeader
from pydantic import BaseModel, ConfigDict, Field, StrictFloat, StrictInt

from .feature_schema import FEATURE_SCHEMA_VERSION
from .predict import ModelArtifactError, ModelPredictor


class CandidateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    candidateId: str = Field(min_length=1, max_length=200)
    features: dict[str, StrictFloat | StrictInt]


class PredictRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    modelVersion: str = Field(min_length=1, max_length=120, pattern=r"^[A-Za-z0-9._-]+$")
    featureSchemaVersion: str = Field(min_length=1, max_length=120)
    candidates: list[CandidateRequest] = Field(min_length=1, max_length=200)


class ScoreResponse(BaseModel):
    modelVersion: str
    featureSchemaVersion: str
    scores: list[dict[str, str | float]]


app = FastAPI(title="TWIGANE Recommendation Model Service", version="1.0")
token_header = APIKeyHeader(name="x-model-service-token", auto_error=False)
store = ModelPredictor(
    os.getenv("MODEL_ARTIFACT_DIR", "runtime/models"),
    os.getenv("MODEL_ACTIVE_VERSION") or None,
)


async def require_service_token(token: Annotated[str | None, Depends(token_header)]):
    expected = os.getenv("MODEL_SERVICE_TOKEN", "")
    if not expected or not token or not hmac.compare_digest(token, expected):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")
    return token


@app.middleware("http")
async def body_limit(request: Request, call_next):
    content_length = request.headers.get("content-length")
    try:
        content_length_value = int(content_length) if content_length else 0
    except ValueError as error:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid content length") from error
    if content_length_value > 256 * 1024:
        raise HTTPException(status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, detail="Request too large")
    return await call_next(request)


@app.get("/health", dependencies=[Depends(require_service_token)])
async def health(modelVersion: str | None = None):
    if modelVersion:
        try:
            return {"status": "ok", **store.inspect(modelVersion)}
        except ModelArtifactError as error:
            raise HTTPException(status_code=503, detail=str(error)) from error
    return {
        "status": "ok",
        "modelVersion": os.getenv("MODEL_ACTIVE_VERSION") or None,
        "featureSchemaVersion": FEATURE_SCHEMA_VERSION,
    }


@app.post("/predict", response_model=ScoreResponse, dependencies=[Depends(require_service_token)])
async def predict(request: PredictRequest):
    if request.featureSchemaVersion != FEATURE_SCHEMA_VERSION:
        raise HTTPException(status_code=422, detail="Unknown feature schema version")
    ids = [candidate.candidateId for candidate in request.candidates]
    if len(set(ids)) != len(ids):
        raise HTTPException(status_code=422, detail="Candidate ids must be unique")
    try:
        scores = store.predict(request.modelVersion, [dict(candidate.features) for candidate in request.candidates])
    except ModelArtifactError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    return ScoreResponse(
        modelVersion=request.modelVersion,
        featureSchemaVersion=request.featureSchemaVersion,
        scores=[{"candidateId": candidate_id, "score": score} for candidate_id, score in zip(ids, scores)],
    )
