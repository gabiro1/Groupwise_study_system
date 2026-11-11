"""Safe LightGBM artifact loading and prediction."""

import json
import math
from pathlib import Path
import re

from .feature_schema import FEATURE_NAMES, FEATURE_SCHEMA_VERSION, validate_features
from .manifest import sha256_file


class ModelArtifactError(ValueError):
    """The artifact cannot safely serve predictions."""


class ModelPredictor:
    def __init__(self, artifact_dir: str | Path, active_version: str | None = None):
        self.artifact_dir = Path(artifact_dir)
        self.active_version = active_version
        self._model = None
        self._manifest = None

    def _load(self, version: str):
        if not re.fullmatch(r"[A-Za-z0-9._-]+", version):
            raise ModelArtifactError("unknown model version")
        if self.active_version and version != self.active_version:
            raise ModelArtifactError("unknown model version")
        directory = self.artifact_dir / version
        manifest_path = directory / "manifest.json"
        model_path = directory / "model.txt"
        if not manifest_path.is_file() or not model_path.is_file():
            raise ModelArtifactError("model artifact is unavailable")
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        if manifest.get("model_version") != version or manifest.get("algorithm") != "LIGHTGBM_LAMBDAMART":
            raise ModelArtifactError("model manifest is invalid")
        if manifest.get("feature_schema_version") != FEATURE_SCHEMA_VERSION:
            raise ModelArtifactError("model feature schema is unsupported")
        if manifest.get("feature_names") != list(FEATURE_NAMES):
            raise ModelArtifactError("model feature names do not match the serving schema")
        if manifest.get("artifact_checksum") != sha256_file(model_path):
            raise ModelArtifactError("model artifact checksum is invalid")
        try:
            import lightgbm as lgb
            model = lgb.Booster(model_file=str(model_path))
        except Exception as error:
            raise ModelArtifactError("model artifact could not be loaded") from error
        self._model = model
        self._manifest = manifest

    def predict(self, version: str, feature_rows: list[dict]) -> list[float]:
        self._load(version)
        matrix = []
        for features in feature_rows:
            errors = validate_features(features)
            if errors:
                raise ModelArtifactError("; ".join(errors))
            values = [float(features[name]) for name in FEATURE_NAMES]
            if not all(math.isfinite(value) for value in values):
                raise ModelArtifactError("feature values must be finite")
            matrix.append(values)
        values = self._model.predict(matrix)
        result = [float(value) for value in values]
        if not all(math.isfinite(value) for value in result):
            raise ModelArtifactError("model returned a non-finite score")
        return result

    def inspect(self, version: str) -> dict:
        """Load and checksum an artifact for an activation health handshake."""
        self._load(version)
        return {
            "modelVersion": self._manifest["model_version"],
            "featureSchemaVersion": self._manifest["feature_schema_version"],
            "artifactChecksum": self._manifest["artifact_checksum"],
        }

    @property
    def manifest(self):
        return self._manifest
