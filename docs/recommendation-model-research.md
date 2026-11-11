# TWIGANE Recommendation Model Research

Status: design and implementation reference. No trained model is claimed by this
document. A model is not eligible for activation until TWIGANE has collected a
real, approved dataset and the evaluation and safety gates described below pass.

## Decision Summary

TWIGANE should use a hybrid recommender:

1. Existing SQL and service-layer eligibility and privacy rules remain mandatory.
2. The deterministic weighted scorer remains the default and the fallback.
3. A population-level learning-to-rank model may rerank only the already eligible
   candidate rows.
4. A bounded student preference profile may adjust the final score only after a
   minimum amount of feedback has been observed.
5. Explanations continue to use stored, auditable feature values. The learned
   model returns scores, not natural-language explanations.

The first learned model is LightGBM LambdaMART. It is not a chatbot, an LLM
prompt, a neural network per student, or an authorization component.

## Why Learning To Rank

The product question is ordered retrieval: for one request, which eligible
students or groups should appear first? A learning-to-rank objective trains on
relative relevance within a request, rather than pretending that each candidate
is an independent classification problem. It can learn interactions such as a
strong availability fit mattering more for a student who studies frequently,
while preserving the request as the unit of evaluation.

A chatbot or general-purpose LLM is a poor scoring authority here. It is not
deterministic enough for reproducible experiments, can invent reasons, cannot be
trusted to enforce database eligibility, and makes it difficult to audit which
feature caused a rank change. Natural-language intent parsing remains separate
from recommendation scoring, as it is in the current application.

## Why LightGBM LambdaMART

LightGBM is suitable for the first trained version because TWIGANE's inputs are
small, structured, mostly numeric compatibility features: course overlap,
availability, topic overlap, complementarity, preferences, activity, capacity,
profile confidence and bounded historical aggregates. Gradient-boosted trees
handle nonlinear thresholds and feature interactions without requiring a large
embedding corpus or a GPU. They are fast to train, compact to serve, and can
produce feature contributions for offline inspection even though TWIGANE does
not use those contributions as user-facing text.

LightGBM's `LGBMRanker` defaults to the `lambdarank` objective. Its ranking API
accepts a `group` array where each value is the number of consecutive rows in a
query, and the group sizes must sum to the number of rows. LambdaMART is the
boosted-tree implementation of LambdaRank; the objective focuses learning on
pairwise ordering errors that affect ranking metrics such as NDCG.

A neural model is not necessary for version one. Neural recommenders are useful
when there is very large, high-dimensional, sequential or multimodal data. They
also add more parameters, more serving complexity, more data hunger and a harder
explanation and safety review. TWIGANE first needs reliable feedback and outcome
coverage. A regularized tree ranker is a proportionate first experiment.

Primary sources:

- LightGBM Python `LGBMRanker` documentation:
  https://lightgbm.readthedocs.io/en/latest/pythonapi/lightgbm.LGBMRanker.html
- LightGBM LambdaRank and query-data documentation:
  https://lightgbm.readthedocs.io/en/latest/Advanced-Topics.html#lambdarank
- LightGBM parameter documentation, including `objective=lambdarank`,
  `label_gain`, grouping and deterministic training:
  https://lightgbm.readthedocs.io/en/latest/Parameters.html
- Ke et al., *LightGBM: A Highly Efficient Gradient Boosting Decision Tree*,
  NeurIPS 2017:
  https://proceedings.neurips.cc/paper_files/paper/2017/hash/6449f44a102fde848669bdd9eb6b76fa-Abstract.html
- Burges, *From RankNet to LambdaRank to LambdaMART: An Overview*, Microsoft
  Research Technical Report MSR-TR-2010-82:
  https://www.microsoft.com/en-us/research/publication/from-ranknet-to-lambdarank-to-lambdamart-an-overview/

## Query and Feature Design

One recommendation request is one ranking query. Its rows contain only the
candidate pool that passed the same eligibility rules used online. Student and
group candidates are kept as separate candidate types, and evaluation reports
are separated by type.

Feature values must be reconstructed from information available at or before the
request timestamp. The versioned first schema contains these safe features:

- shared course count and same-program indicator
- course compatibility
- skill complementarity
- topic similarity
- goal compatibility
- availability overlap
- preferred mode and study-style compatibility
- group-size compatibility
- candidate activity score and group dormancy
- candidate capacity ratio and group age
- profile data confidence and completed profile-field count
- prior accepted recommendation count for the requester
- prior helpful-feedback rate for the requester, only after the configured
  minimum sample size
- prior group retention rate for the requester, only after the configured
  minimum sample size and only as a historical aggregate

The schema excludes gender, religion, race, ethnicity, disability, passwords,
tokens, raw names and emails, raw private messages, and unnecessary identifiers.
Course and academic-level slices are evaluation dimensions, not unrestricted
features that can expose private identity. A request ID and candidate ID are
represented offline by a keyed hash or training-only identifier; the inference
service receives only the candidate ID needed to pair returned scores with the
already filtered rows.

Every row records a feature-schema version, model/data version, anonymized query
ID, candidate type, training candidate ID, group/query ID, label, timestamp and
source model version. Outcome columns are labels or metadata and are never input
features for that same historical request.

## Labels and Leakage Controls

Labels are graded relevance and are configurable in `labels.py`. The initial
policy is:

| Relevance | Meaning |
| ---: | --- |
| 0 | Rejected, dismissed, or explicitly negative feedback |
| 1 | Shown with no later interaction in the observation window |
| 2 | Clicked or opened |
| 3 | Accepted an invitation or join request |
| 4 | Positive recommendation feedback |
| 5 | Joined and remained active through the medium-term window |
| 6 | Joined, attended sessions, and gave positive satisfaction feedback |

The label builder records separate immediate, medium-term and long-term outcome
components. A shown event alone is never treated as success. A student leaving a
group can become a later label, but it is not allowed to become an input feature
for the request that preceded the join. Observation windows and label precedence
are explicit so a later event cannot leak backward into an earlier feature
snapshot.

The LambdaMART label gain is documented with the model manifest. Higher integer
labels mean higher relevance, and the model is trained with a fixed gain mapping
that is changed only through a versioned configuration change.

## Data Readiness

The service refuses to train or activate when data is too sparse. Conservative
defaults are configurable through environment variables and the admin status
surface:

- at least 100 unique students
- at least 500 recommendation requests
- at least 10,000 labelled candidate rows
- at least 100 positive outcomes and 100 negative outcomes
- at least 20 groups or partner interactions
- at least 5 represented courses
- at least 3 distinct relevance labels

These are operational gates, not claims about statistical sufficiency for every
future study. They prevent a model from being fitted to a handful of users or a
single course. The readiness report returns the first failing condition and its
observed count. Until all conditions pass, the UI says "Not enough real data for
training", no fake accuracy is shown, and weighted scoring continues.

Synthetic data may exercise export, schema validation and service tests. It is
marked synthetic in metadata, cannot be activated, and must never be reported as
real validation or thesis evidence.

## Splits and Training

The export is sorted by request timestamp and split by time, for example 70%
train, 15% validation and 15% test. All rows from a request remain together in
one split. A future request must never influence a past request. If a time split
does not contain enough query diversity or label diversity, the run fails rather
than silently switching to a random split.

Training steps:

1. Export approved, anonymized rows from the database.
2. Validate the feature schema, finite numeric values, allowed candidate types,
   query contiguity and label distribution.
3. Build LightGBM matrices and a query-size array.
4. Fit a regularized LambdaMART ranker with a fixed seed and CPU-deterministic
   settings.
5. Evaluate the model and the weighted-scoring baseline on the same held-out
   requests.
6. Save the model artifact, feature schema, evaluation report and manifest.
7. Refuse activation unless all quality, checksum, coverage and fairness gates
   pass.

LightGBM's documented `Booster.save_model()` and `Booster(model_file=...)` paths
are used for serialization. The manifest stores a SHA-256 checksum, dependency
versions, application commit/version, data date range and the schema hash.
Artifacts and exported rows are runtime data and are ignored by source control;
real student data is never committed.

## Evaluation Plan

The primary offline metric is NDCG@5 because it supports graded relevance and
rewards placing stronger outcomes near the top of a request. The required
secondary ranking metrics are Precision@1, Precision@3, Precision@5, Recall@5
where a valid positive exists, and MRR where a first relevant result is defined.
The scikit-learn definition of NDCG is discounted gain divided by the ideal DCG,
with a result between zero and one:

https://scikit-learn.org/stable/modules/generated/sklearn.metrics.ndcg_score.html

Operational metrics are reported from real outcomes, not inferred model scores:
acceptance rate, click-through rate, helpful-feedback rate, group-join rate,
reliability. Baseline and learned-model metrics use the same request population
and time window whenever possible.

Reports are split for partner versus group recommendations, complete versus
incomplete profiles, courses, and academic levels when sample sizes support a
meaningful and privacy-preserving comparison. Small subgroups are suppressed.
The model can be activated only if it matches or beats the baseline on NDCG@5,
does not materially reduce safety or eligible coverage, has no unacceptable
subgroup difference, has a matching schema, has a valid checksum and has a stored
evaluation report. No online activation is automatic.

## Cold Start and Personalization

New students receive the deterministic weighted model with neutral missing-data
handling and an honest confidence caveat. They are not penalized merely for
having an incomplete profile, and they do not receive a student-specific model.

Personalization is a separate, bounded aggregate profile. It uses accepted and
rejected recommendations, helpful feedback and reasons, preferred modes and
times, group joining and retention, and repeated successful partner types. It
uses smoothing toward the population/default profile and requires at least five
events before a dimension influences ranking. One rejection cannot cause a large
change. The configured maximum adjustment applies to the final score and the
layer cannot override eligibility, privacy, capacity, archived-group or course
rules.

The baseline score remains in every response, and the user-facing explanation
may say only that the result was personalized from previous recommendation
feedback. It must not disclose private behavioral counts or feedback reasons to
another student.

## Privacy, Safety and Fairness

Filtering happens before feature generation and before any model call. The
ranker is never allowed to choose from an unrestricted database result. It cannot
authorize access, bypass group privacy or capacity, return archived groups,
return current members, select an ineligible course, or see private message text.

The Python service receives structured, bounded numeric rows and opaque candidate
IDs only. It has no database credentials. The internal endpoint requires a
deployment secret in a header, uses strict request models, rejects unknown or
missing features and limits candidate count and body size. It is bound to the
private network, should be protected by TLS or a trusted sidecar/proxy in
production, and must not be exposed directly to browsers.

FastAPI documents `APIKeyHeader` and bearer security dependencies for rejecting
unauthenticated requests and `TrustedHostMiddleware` / HTTPS middleware for
deployment hardening:

- https://fastapi.tiangolo.com/reference/security/
- https://fastapi.tiangolo.com/tutorial/security/first-steps/
- https://fastapi.tiangolo.com/advanced/middleware/

Fairness checks are aggregate monitoring gates, not a reason to collect sensitive
attributes into the model. Sensitive attributes are excluded from training. If a
lawful, consented audit dataset exists outside model inputs, subgroup metrics are
computed only with sufficient sample sizes and are not shown when a group could
be re-identified. A material degradation or coverage disparity blocks activation
and triggers weighted fallback.

## Fallback and Operational Status

`RECOMMENDATION_ALGORITHM=WEIGHTED_SCORING` is the default. A trained model is
used only when an administrator has activated a validated artifact, the data
readiness gate is satisfied, the feature schema matches, and the model service
returns valid scores within the timeout. Missing service, timeout, unknown model,
bad checksum, invalid output or a failed circuit records a degraded event and
uses the weighted scorer for the same eligible candidates.

Each response exposes the active algorithm, model version, baseline score,
personalization state, training readiness and degraded state. Administrators can
inspect readiness, training history, evaluation metrics, model-service health and
fallback counts. Training and activation are separate actions; deactivation
restores the weighted baseline without changing eligibility.
