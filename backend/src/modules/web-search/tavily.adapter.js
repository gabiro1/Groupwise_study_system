import { WebSearchError } from "./errors.js";
import { normaliseTavilyResponse } from "./normalise.js";

function tavilyTimeRange(value) {
  return { pd: "day", pw: "week", pm: "month", py: "year" }[value] ?? undefined;
}

function tavilyDateRange(value) {
  const match = /^(\d{4}-\d{2}-\d{2})to(\d{4}-\d{2}-\d{2})$/.exec(String(value ?? ""));
  return match
    ? { start_date: match[1], end_date: match[2], filter_by_published_date: true }
    : {};
}

function tavilyCountry(value) {
  const code = String(value ?? "").trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) return undefined;
  try {
    return new Intl.DisplayNames(["en"], { type: "region" }).of(code)?.toLowerCase();
  } catch {
    return undefined;
  }
}

async function readResponse(response) {
  const text = await response.text().catch(() => "");
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }
  return { text, payload };
}

export const tavilyAdapter = Object.freeze({
  provider: "tavily",
  async search(query, { baseUrl, apiKey, timeoutMs, ...options }) {
    const endpoint = `${String(baseUrl).replace(/\/$/, "")}/search`;
    const timeRange = tavilyTimeRange(options.freshness);
    const dateRange = tavilyDateRange(options.freshness);
    const body = {
      query,
      search_depth: "basic",
      max_results: options.maxResults,
      include_published_date: true,
      include_raw_content: false,
      include_domains: options.includeDomains,
      exclude_domains: options.excludeDomains,
      country: tavilyCountry(options.country),
      language: options.language,
      safe_search: options.safeSearch !== "off",
      ...(timeRange ? { time_range: timeRange } : {}),
      ...dateRange,
    };

    let response;
    try {
      response = await fetch(endpoint, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      if (error?.name === "TimeoutError" || error?.name === "AbortError") {
        throw new WebSearchError("The web research provider timed out.", { code: "WEB_SEARCH_TIMEOUT", context: { provider: "tavily" } });
      }
      throw new WebSearchError("The web research provider could not be reached.", { code: "WEB_SEARCH_NETWORK_ERROR", context: { provider: "tavily" } });
    }

    const { text, payload } = await readResponse(response);
    if (!response.ok) {
      const code = response.status === 401 || response.status === 403
        ? "WEB_SEARCH_AUTH_FAILED"
        : response.status === 429
          ? "WEB_SEARCH_PROVIDER_RATE_LIMITED"
          : "WEB_SEARCH_PROVIDER_ERROR";
      throw new WebSearchError("The web research provider returned an error.", {
        code,
        context: { provider: "tavily", status: response.status, bodyLength: text.length },
      });
    }

    return normaliseTavilyResponse(payload);
  },
});
