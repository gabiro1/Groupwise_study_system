import { WebSearchError } from "./errors.js";
import { normaliseBraveResponse } from "./normalise.js";

function tokenBudget(maxContextChars) {
  return Math.min(32_768, Math.max(1024, Math.round(Number(maxContextChars || 24_000) / 4)));
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

export const braveAdapter = Object.freeze({
  provider: "brave",
  async search(query, { baseUrl, apiKey, timeoutMs, ...options }) {
    const endpoint = `${String(baseUrl).replace(/\/$/, "")}/llm/context`;
    const url = new URL(endpoint);
    url.searchParams.set("q", query);
    url.searchParams.set("country", options.country);
    url.searchParams.set("search_lang", options.language);
    url.searchParams.set("count", String(options.maxResults));
    url.searchParams.set("maximum_number_of_urls", String(options.maxResults));
    url.searchParams.set("maximum_number_of_tokens", String(tokenBudget(options.maxContextChars)));
    url.searchParams.set("context_threshold_mode", "strict");
    url.searchParams.set("safesearch", options.safeSearch);
    url.searchParams.set("enable_source_metadata", "true");
    if (options.freshness) url.searchParams.set("freshness", options.freshness);

    let response;
    try {
      response = await fetch(url, {
        method: "GET",
        headers: {
          accept: "application/json",
          "accept-encoding": "gzip",
          "x-subscription-token": apiKey,
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      if (error?.name === "TimeoutError" || error?.name === "AbortError") {
        throw new WebSearchError("The web research provider timed out.", { code: "WEB_SEARCH_TIMEOUT", context: { provider: "brave" } });
      }
      throw new WebSearchError("The web research provider could not be reached.", { code: "WEB_SEARCH_NETWORK_ERROR", context: { provider: "brave" } });
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
        context: { provider: "brave", status: response.status, bodyLength: text.length },
      });
    }

    return normaliseBraveResponse(payload);
  },
});
