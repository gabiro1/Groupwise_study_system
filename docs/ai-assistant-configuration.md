# AI Assistant Configuration

## Required environment behaviour

The backend starts with web research disabled and without a web-search key. A
missing Brave or Tavily key is a disabled capability, not a startup failure.
Keys are read only by the backend and are never returned to the browser.

Copy `backend/.env.example` and set the existing database/auth values first.

## Web research variables

| Variable | Default | Purpose |
|---|---:|---|
| `AI_WEB_RESEARCH_ENABLED` | `false` | Deployment-level outbound-search gate |
| `AI_WEB_RESEARCH_DEFAULT_MODE` | `LOCAL` | Default `LOCAL`, `WEB`, `BOTH`, or `AUTO` mode |
| `AI_WEB_RESEARCH_MAX_QUERIES` | `2` | Per-request query budget for future multi-query research |
| `AI_WEB_RESEARCH_MAX_RESULTS` | `8` | Maximum sources returned to the model |
| `AI_WEB_RESEARCH_TIMEOUT_MS` | `10000` | Provider request timeout |
| `AI_WEB_RESEARCH_MAX_CONTEXT_CHARS` | `24000` | Web content budget sent to the model |
| `AI_WEB_RESEARCH_CACHE_TTL_MIN` | `30` | In-memory public-result cache lifetime |
| `AI_WEB_RESEARCH_MAX_REQUESTS_PER_HOUR` | `20` | Per-student application search budget |
| `AI_WEB_RESEARCH_COUNTRY` | `RW` | Provider country hint |
| `AI_WEB_RESEARCH_LANGUAGE` | `en` | Provider language hint |
| `AI_WEB_RESEARCH_SAFESEARCH` | `strict` | `off`, `moderate`, or `strict` |
| `AI_WEB_RESEARCH_ALLOWLIST_DOMAINS` | empty | Optional comma-separated trusted domains |
| `AI_WEB_RESEARCH_BLOCKLIST_DOMAINS` | empty | Optional comma-separated blocked domains |
| `AI_WEB_RESEARCH_STORE_RAW_CONTENT` | `false` | Reserved; raw content is not stored by default |
| `WEB_SEARCH_PROVIDER` | `brave` | `none`, `brave`, or `tavily` |
| `WEB_SEARCH_FALLBACK_PROVIDER` | `tavily` | Optional second provider |
| `BRAVE_SEARCH_API_KEY` | empty | Server-only Brave key |
| `BRAVE_SEARCH_BASE_URL` | Brave LLM Context base URL | Brave API base URL |
| `TAVILY_API_KEY` | empty | Server-only Tavily key |
| `TAVILY_BASE_URL` | Tavily API base URL | Tavily API base URL |

Example enablement:

```text
AI_WEB_RESEARCH_ENABLED=true
WEB_SEARCH_PROVIDER=brave
BRAVE_SEARCH_API_KEY=<server-secret>
```

The administrator must also leave public research enabled in the AI console.
The environment flag is a hard safety gate, so the console cannot accidentally
turn research on when deployment configuration has it off.

## Administrator controls

`/admin/ai` can configure the persisted `ai.web` section:

- availability and default source mode;
- maximum result count;
- per-student hourly search budget;
- cache lifetime;
- safe-search mode, country, and language;
- trusted and blocked domains.

Credentials, base URLs, raw queries, private context, and raw web pages are not
editable or visible in the browser.

## Local testing

Automated tests mock `globalThis.fetch`; they never call Brave, Tavily, or a paid
language-model endpoint. The backend unit suite is:

```powershell
cd backend
npm test
```

For a real local smoke test, use a dedicated test database, configure a test
provider key outside source control, and keep `AI_WEB_RESEARCH_STORE_RAW_CONTENT`
false. The provider documentation should be rechecked before production
enablement because vendor limits and response schemas can change.
