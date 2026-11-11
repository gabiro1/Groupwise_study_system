# TWIGANE Hybrid AI Assistant Architecture

## Thesis-facing explanation

> TWIGANE uses a hybrid grounded AI assistant. It answers from authorised
> TWIGANE study material and can optionally perform citation-based public web
> research. The language model is configured and grounded with retrieved
> evidence; it is not retrained for every student.

This assistant is separate from the deterministic recommendation and student
matching system. No recommendation weights, ranking logic, trained model, or
matching data is sent to the web-search layer.

## Modes

- **LOCAL**: retrieves only material the authenticated student may already read.
  It never calls a web-search provider.
- **WEB**: searches approved public sources only. It does not retrieve or send
  local resources, workspace messages, group names, or private student data.
- **BOTH**: retrieves authorized local evidence and public web evidence in
  separate labelled source sets.
- **AUTO**: retrieves local evidence first. It searches publicly only when the
  local evidence is absent or weak, or when the question asks for current,
  recent, research, or citation-backed information.

The default is `LOCAL` unless an administrator changes the configured default.
The interface tells the student whether internet research was performed.

## Request flow

```text
authenticated request
  -> Zod request validation and source-mode resolution
  -> workspace/resource authorization in SQL
  -> local keyword retrieval, if required
  -> privacy-safe public query derivation, if required
  -> web provider policy, cache, rate limit, and failover
  -> normalized [LOCAL:n] and [WEB:n] evidence labels
  -> grounded prompt through the existing AI provider orchestration
  -> citation validation and invalid-citation removal
  -> answer, sources, search metadata, limitations, and telemetry
```

The model receives only evidence selected by the backend. It is not trusted to
decide whether a document is private or public. Uploaded resource text and web
content are delimited as untrusted data; instructions inside them are not
executed.

## Local librarian

Local retrieval preserves the existing authorization-first design:

- workspace resources require active membership through `workspace_groups`;
- course resources require active enrollment in `student_courses`;
- private resources require the current student to be the uploader;
- deleted and unextractable resources are excluded;
- workspace messages require active membership and are read-only context;
- global questions may use the current student's own courses, goals, groups,
  upcoming sessions, and accepted study partners.

Retrieval is bounded keyword overlap over `extracted_text`/description. It does
not claim embeddings or semantic search. If no authorized evidence exists, the
assistant returns a no-context response instead of fabricating an answer.

## Web-search boundary

Web search lives under `backend/src/modules/web-search/`:

- `provider.js` exposes the provider-neutral `searchWeb` interface and handles
  cache, per-student hourly limits, failover, and structured errors;
- `brave.adapter.js` implements Brave LLM Context;
- `tavily.adapter.js` implements the optional Tavily Search fallback;
- `normalise.js` produces stable source records;
- `policies.js` applies safe search, domain, freshness, query, result, timeout,
  and context limits;
- `registry.js` exposes only providers with a configured server-side key.

The search provider never receives local context. The search query is derived
from the question after removing URLs, email addresses, phone numbers, UUIDs,
and obvious private-resource markers. Raw web content is not persisted by
default.

## Prompt and citations

The dedicated grounding prompt requires `[LOCAL:n]` and `[WEB:n]` citations,
source separation, uncertainty statements, date awareness, disagreement
disclosure, and academic-integrity-aware tutoring. The backend maps citations to
actual normalized source records. Invalid or fake identifiers are removed and
recorded as citation-invalid telemetry; fake URLs are never displayed.

## Failure behaviour

- AI provider disabled: return a safe unavailable result; local application
  features continue to work.
- Web research disabled: explicit web mode returns a disabled result; hybrid and
  automatic modes degrade to local evidence where possible.
- Search timeout/provider failure: explicit web mode returns a safe provider
  error; hybrid/automatic modes continue locally and disclose the limitation.
- No evidence: return `answer: null` with a reliable no-source message.
- Model cites no valid evidence: return no grounded answer.

## Administrative visibility

The admin AI page shows model/provider metadata without credentials, web-search
health, safe-search state, source limits, policy controls, failover state, and
separate web-search usage counters. API keys remain environment-only.
