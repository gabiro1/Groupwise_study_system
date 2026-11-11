import crypto from "node:crypto";

function canonicalUrl(value) {
  try {
    const url = new URL(String(value));
    if (!["http:", "https:"].includes(url.protocol)) return null;
    url.hash = "";
    return url.href;
  } catch {
    return null;
  }
}

function domainFromUrl(value) {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function sourceId(provider, url) {
  return `${provider}:${crypto.createHash("sha256").update(url).digest("hex").slice(0, 20)}`;
}

function dateFromValue(value) {
  const text = String(value ?? "").trim();
  const iso = /\b(\d{4}-\d{2}-\d{2}(?:T[0-9:.+-]+Z?)?)\b/.exec(text)?.[1];
  if (!iso) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function publicRecord({ provider, title, url, snippet, content, publishedAt, retrievedAt, relevance }) {
  const canonical = canonicalUrl(url);
  if (!canonical) return null;

  const cleanSnippet = String(snippet ?? content ?? "").trim().slice(0, 1800);
  const cleanContent = String(content ?? snippet ?? "").trim().slice(0, 16_000);

  return {
    id: sourceId(provider, canonical),
    title: String(title ?? domainFromUrl(canonical) ?? "Web source").trim().slice(0, 300),
    url: canonical,
    domain: domainFromUrl(canonical),
    snippet: cleanSnippet,
    content: cleanContent,
    publishedAt: dateFromValue(publishedAt),
    retrievedAt: retrievedAt ?? new Date().toISOString(),
    provider,
    relevance: Number.isFinite(Number(relevance)) ? Number(relevance) : null,
  };
}

function bravePublishedAt(metadata) {
  const ages = Array.isArray(metadata?.age) ? metadata.age : [];
  return ages.find((value) => /\b\d{4}-\d{2}-\d{2}T/.test(String(value)))
    ?? ages.find((value) => /^\d{4}-\d{2}-\d{2}$/.test(String(value)))
    ?? null;
}

export function normaliseBraveResponse(payload, retrievedAt = new Date().toISOString()) {
  const metadata = payload?.sources && typeof payload.sources === "object" ? payload.sources : {};
  const generic = Array.isArray(payload?.grounding?.generic) ? payload.grounding.generic : [];

  return generic
    .map((entry) => {
      const url = entry?.url;
      const meta = metadata[url] ?? {};
      const snippets = Array.isArray(entry?.snippets) ? entry.snippets : [];
      const content = snippets.map((snippet) => String(snippet ?? "").trim()).filter(Boolean).join("\n\n");
      return publicRecord({
        provider: "brave",
        title: entry?.title ?? meta.title,
        url,
        snippet: content,
        content,
        publishedAt: bravePublishedAt(meta),
        retrievedAt,
        relevance: entry?.relevance ?? entry?.score,
      });
    })
    .filter(Boolean);
}

export function normaliseTavilyResponse(payload, retrievedAt = new Date().toISOString()) {
  return (Array.isArray(payload?.results) ? payload.results : [])
    .map((entry) => publicRecord({
      provider: "tavily",
      title: entry?.title,
      url: entry?.url,
      snippet: entry?.content,
      content: entry?.raw_content || entry?.content,
      publishedAt: entry?.published_date,
      retrievedAt,
      relevance: entry?.score,
    }))
    .filter(Boolean);
}

export function cloneSources(sources) {
  return (Array.isArray(sources) ? sources : []).map((source) => ({ ...source }));
}
