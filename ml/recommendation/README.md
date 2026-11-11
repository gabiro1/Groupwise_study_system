# TWIGANE Recommendation Learning Package

This package trains and serves the optional population-level recommendation
ranker. It does not contain real student data or trained artifacts. Runtime data,
model files and exported datasets belong in the ignored directories listed in
`.gitignore`.

## Components

- `config.py`: conservative readiness and training configuration.
- `feature_schema.py`: exact feature names and validation rules.
- `labels.py`: documented graded-label policy with immediate, medium-term and
  long-term outcomes.
- `export_dataset.py`: exports approved, anonymized recommendation rows from
  PostgreSQL; it never exports names, emails, messages, passwords or tokens.
- `build_features.py`: validates JSONL rows and converts query groups to matrices.
- `train.py`: time-split LightGBM LambdaMART training and release gates.
- `evaluate.py`: NDCG, Precision@K, Recall@K, MRR and outcome metrics against the
  weighted baseline.
- `predict.py`: checksum- and schema-checked model loading.
- `manifest.py`: reproducible model metadata and artifact checksum.
- `service.py`: small FastAPI score-only inference endpoint.

## Install

```text
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
```

## Export and train

```text
python -m ml.recommendation.export_dataset --database-url "$DATABASE_URL" --output ml/recommendation/runtime/data/recommendation.jsonl --hash-salt "$RECOMMENDATION_HASH_SALT"
python -m ml.recommendation.train --dataset ml/recommendation/runtime/data/recommendation.jsonl --output-dir ml/recommendation/runtime/models --git-commit "$GIT_COMMIT"
```

The trainer refuses insufficient or invalid data. A successful training run is
not automatically activated. An administrator must review the manifest and
evaluation report, then activate the validated artifact through the Node admin
API.

Synthetic rows can be used only for pipeline tests by marking the dataset
`SYNTHETIC`. Synthetic metrics are never activation-eligible and must not be
reported as real validation.

## Run the internal service

```text
MODEL_SERVICE_TOKEN="a-long-random-secret" \
MODEL_ARTIFACT_DIR=ml/recommendation/runtime/models \
MODEL_ACTIVE_VERSION=ltr-v1.0.0 \
uvicorn ml.recommendation.service:app --host 127.0.0.1 --port 8010
```

`/health` and `POST /predict` require `X-Model-Service-Token` and accept only
bounded, structured feature rows. The Node API performs eligibility and
explanations.
The service has no database credentials and should remain on a private network.
