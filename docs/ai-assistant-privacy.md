# AI Assistant Privacy and Academic Integrity

## Data boundaries

LOCAL mode sends authorized study evidence to the configured language-model
provider through the existing server-side orchestration chain. WEB mode sends a
privacy-safe version of the student's question to the configured search
provider and does not send local resources, workspace identifiers, group names,
messages, student names, or private context. BOTH and AUTO follow the same
separation: local evidence is retrieved independently and is never appended to a
public search request.

The model cannot grant access. SQL predicates authorize data before retrieval,
including active workspace membership, active course enrollment, and private
uploader ownership. Web results and uploaded text are untrusted data and their
instructions are ignored.

## Retention

- Raw web pages are not stored by default.
- The lightweight web audit stores actor id, source mode, provider, query hash,
  source domains, count, latency, status, and error code only.
- AI usage telemetry stores routing metadata, not prompts or responses.
- Local AI conversation storage follows the existing soft-delete and access
  rules; it should not be used as a reason to expose another student's data.
- Search results may be cached in process for the configured TTL. The cache key
  uses the redacted query and public search options, never local context.

Provider retention and processing terms remain provider-specific. Operators
should review the official Brave, Tavily, and language-model data policies before
using the feature with sensitive academic or personal information.

## Security controls

- server-side API keys only;
- request timeouts and bounded result/context sizes;
- application-level per-student hourly search limits in addition to the existing
  AI request limiter;
- allowlist/blocklist filtering after provider normalization;
- HTTP(S)-only, validated external links in the frontend;
- no raw HTML rendering;
- invalid citation identifiers are removed;
- provider errors never include response bodies or secrets;
- no outbound URL fetching, so this feature does not introduce an SSRF fetcher;
- web search is disabled by default.

The hourly limiter is process-local. A multi-instance deployment should add a
shared counter at the edge or in a shared store before relying on it as the only
abuse-control layer.

## Academic integrity

The assistant is a tutor, not a lecturer or assessment impersonator. It is
prompted to explain concepts, show evidence, disclose uncertainty, and avoid
simply completing dishonest academic work. Students remain responsible for
checking cited sources and following their institution's assessment rules.

Web citations show public evidence; local citations show TWIGANE material. A
citation is evidence provenance, not a guarantee that a claim is correct.
