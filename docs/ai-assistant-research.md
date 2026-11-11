# TWIGANE AI Assistant Provider Research

**Reviewed:** 2026-11-08

## Decision

TWIGANE uses a provider-neutral web-search boundary and selects **Brave Search
LLM Context** as the default provider when web research is explicitly enabled.
Tavily remains an optional fallback. Web search is kept separate from the
language-model provider so the application can enforce privacy, source policy,
rate limits, caching, citation mapping, and provider failover before any
retrieved content reaches the existing AI orchestration layer.

## Providers Reviewed

### Brave Search LLM Context

- Official documentation: <https://api-dashboard.search.brave.com/documentation/services/llm-context>
- Endpoint: `GET` or `POST https://api.search.brave.com/res/v1/llm/context`.
- Authentication: `X-Subscription-Token: <BRAVE_SEARCH_API_KEY>`; the key is
  sent only by the backend.
- Request contract used by TWIGANE: `q`, `country`, `search_lang`,
  `freshness`, `maximum_number_of_urls`, `maximum_number_of_tokens`,
  `context_threshold_mode`, `safesearch`, and `enable_source_metadata`.
  These are documented LLM Context parameters; application-side domain policy
  is applied after retrieval because the LLM Context contract does not expose
  Tavily-style `include_domains` and `exclude_domains` fields.
- Response structure: `grounding.generic[]` contains a URL, title, and
  extracted `snippets[]`; `sources` is an object keyed by URL and may contain
  title, hostname, age, description, and fetched-content timestamp metadata.
- Citation/source format: source URLs and metadata are returned by Brave. TWIGANE
  assigns its own stable `[WEB:n]` labels and maps only those labels back to
  returned metadata. It never trusts a URL or citation invented by the model.
- Limits: the documented query range is 1-600 characters and at most 75 words;
  context controls are 1-50 URLs, 1,024-32,768 approximate tokens, and
  512-8,192 tokens per URL. Brave documents a one-second sliding-window
  consideration and its Search plan currently lists 50 queries/second.
  TWIGANE applies much smaller application limits: two searches per request by
  default, eight sources, a bounded context character budget, a timeout, and a
  per-student hourly budget.
- Cost: Brave’s Search plan currently lists $5 per 1,000 requests, with
  monthly included credits shown on its plans page. Search cost and any
  language-model token cost are separate concerns.
- Privacy: Brave’s Search API page states that its own-index architecture does
  not share or train on queries and describes architectural zero data retention.
  That vendor statement does not change TWIGANE’s rule: private workspace text,
  names, messages, resource contents, and identifying details are not sent to
  Brave. Raw web content is not stored by default.
- Limitations: extracted snippets are untrusted input, dates may be absent or
  provider-estimated, domain filtering is enforced locally after the response,
  and the endpoint is still subject to the account’s plan, availability, and
  evolving versioned API behaviour. Brave documents dated `Api-Version` headers;
  TWIGANE does not pin one until the deployment has a tested compatibility
  target.

### Tavily Search

- Official documentation: <https://docs.tavily.com/documentation/api-reference/endpoint/search.md>
- Endpoint: `POST https://api.tavily.com/search`.
- Authentication: `Authorization: Bearer <TAVILY_API_KEY>`; the key remains
  server-side.
- Request contract used by TWIGANE: `query`, `search_depth: "basic"`,
  `max_results`, `include_published_date`, `include_domains`,
  `exclude_domains`, `country`, `language`, and `safe_search`. Raw page content
  and provider-generated answers are not requested by default.
- Response structure: `results[]` records contain `title`, `url`, `content`,
  `score`, optional `published_date`, and optional provider `id`. The response
  also includes the submitted query and response timing/usage metadata.
- Citation/source format: TWIGANE maps each result URL to a normalized source
  record and assigns `[WEB:n]`; Tavily’s URL is treated as untrusted data and is
  validated before it is returned or linked.
- Limits and cost: Tavily documents Development keys at 100 requests/minute
  and Production keys at 1,000 requests/minute. Basic Search costs one API
  credit and Advanced Search costs two; current pricing lists 1,000 free
  monthly credits and pay-as-you-go pricing. TWIGANE uses Basic Search for the
  default path and imposes its own lower per-student and per-request budgets.
- Privacy: Tavily receives the public, privacy-safe query only. Private TWIGANE
  context is never used as the request body or as a query expansion source.
- Limitations: Tavily’s safe-search option is boolean rather than Brave’s
  `strict`/`moderate`/`off` values; TWIGANE maps any enabled safe-search policy
  to `true`. Provider dates are estimates and the provider may return fewer
  results after filters or plan limits.

## Language-Model Provider Review

The existing TWIGANE model path uses OpenAI-compatible Chat Completions and an
Anthropic adapter behind a registry, circuit breaker, and failover orchestrator.
OpenAI’s current Chat Completions documentation describes `POST
/chat/completions`, `messages`, `model`, `response_format`, and the standard
`choices[0].message.content` response shape. It recommends the newer Responses
API for new projects, but the existing provider-compatible path is retained to
avoid changing authentication, failover, or model behaviour outside this task.

OpenAI’s current web-search documentation describes a hosted Responses API
`web_search` tool. It can return URL annotations and complete source lists, but
it also couples retrieval to the OpenAI Responses provider and its own model
tool-selection behaviour. It is therefore retained as a future alternative,
not enabled in this implementation. Keeping search separate ensures that a
Brave or Tavily result is still passed through TWIGANE’s own authorization,
untrusted-content, source-label, citation-validation, and privacy controls.

Official references:

- Chat Completions: <https://platform.openai.com/docs/api-reference/chat/create>
- Responses web search: <https://platform.openai.com/docs/guides/tools-web-search>
- OpenAI rate limits: <https://platform.openai.com/docs/guides/rate-limits>
- OpenAI data controls: <https://platform.openai.com/docs/guides/your-data>
- OpenAI pricing and web-search tool pricing: <https://developers.openai.com/api/docs/pricing>

## Operational Assumptions

- Web research is disabled by default and the application starts without a
  web-search key.
- A model provider is still required to produce an answer; search results alone
  are never displayed as an AI answer.
- A single student question currently creates at most one provider search. The
  configurable query budget is retained for future multi-query research without
  weakening the present limit.
- Web pages and uploaded resources are untrusted data. Their instructions are
  never executed and cannot override the system prompt or backend policy.
- Provider outages, timeouts, quota errors, empty grounding, and invalid model
  citations degrade to a safe unavailable/no-evidence response or to a local
  answer in hybrid mode. Error responses never contain provider bodies, keys, or
  private context.
- Vendor pricing, limits, retention terms, and response schemas can change.
  Deployments should recheck the linked official documentation before enabling
  production web research.
