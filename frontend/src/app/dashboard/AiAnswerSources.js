"use client";

export const SOURCE_MODE_OPTIONS = [
  { value: "LOCAL", label: "My study material", description: "Use only authorized TWIGANE material." },
  { value: "WEB", label: "Internet research", description: "Use public web sources with citations." },
  { value: "BOTH", label: "Both", description: "Keep local and public sources separate." },
  { value: "AUTO", label: "Automatic", description: "Start local and search only when needed." },
];

export function sourceModeLabel(value) {
  return SOURCE_MODE_OPTIONS.find((option) => option.value === value)?.label ?? "My study material";
}

function safeExternalUrl(value) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

export function SourceModeSelector({ id, value, onChange, disabled = false, webEnabled = true }) {
  return (
    <label className="ai-source-mode-field" htmlFor={id}>
      <span>Answer from</span>
      <select id={id} value={value} onChange={(event) => onChange(event.target.value)} disabled={disabled}>
        {SOURCE_MODE_OPTIONS.map((option) => (
          <option key={option.value} value={option.value} disabled={!webEnabled && ["WEB", "BOTH"].includes(option.value)}>
            {option.label}
          </option>
        ))}
      </select>
      <small>{SOURCE_MODE_OPTIONS.find((option) => option.value === value)?.description}</small>
    </label>
  );
}

export function SourceModeNotice({ sourceMode, searches = [] }) {
  const searched = searches.length > 0;
  return (
    <div className="ai-source-mode-notice" role="status">
      <strong>{sourceModeLabel(sourceMode)}</strong>
      {sourceMode === "LOCAL" && <span>Only your authorized TWIGANE study material is used.</span>}
      {sourceMode === "WEB" && <span>{searched ? "Public internet research was performed." : "Public sources will be used when available."}</span>}
      {sourceMode === "BOTH" && <span>{searched ? "Local material and public web sources are shown separately." : "Local material and public research are kept separate."}</span>}
      {sourceMode === "AUTO" && <span>{searched ? "Local material was checked first, then public research was performed." : "Local material was checked first; no internet search was needed."}</span>}
    </div>
  );
}

export function AnswerSources({ sources = [], searches = [], sourcesDisagree = false, limitations = [] }) {
  const localSources = sources.filter((source) => source.sourceType === "LOCAL" || !source.url);
  const webSources = sources.filter((source) => source.sourceType === "WEB" || Boolean(source.url));

  return (
    <div className="ai-answer-evidence">
      {searches.length > 0 && (
        <div className="ai-research-status">
          Internet research performed · {searches.reduce((sum, search) => sum + (search.sourceCount || 0), 0)} source{searches.reduce((sum, search) => sum + (search.sourceCount || 0), 0) === 1 ? "" : "s"} found
        </div>
      )}
      {sourcesDisagree && <div className="ai-evidence-warning" role="status">Sources disagree. Review the cited material before relying on the conclusion.</div>}
      {limitations.filter((item) => !item.toLowerCase().includes("sources disagree")).map((item) => <div className="ai-evidence-limitation" key={item}>{item}</div>)}
      {localSources.length > 0 && (
        <section className="ai-source-group" aria-label="Local study sources">
          <h4>From your study material</h4>
          <div className="ai-source-grid">
            {localSources.map((source) => (
              <article className="ai-source-card local" key={source.id || source.resourceId || source.title}>
                <div className="ai-source-card-heading"><span>{source.id}</span><strong>{source.title}</strong></div>
                <small>{source.kind === "GROUP_MESSAGE" ? "Group discussion" : "TWIGANE material"}</small>
                {source.excerpt && <p>{source.excerpt}</p>}
              </article>
            ))}
          </div>
        </section>
      )}
      {webSources.length > 0 && (
        <section className="ai-source-group" aria-label="Public web sources">
          <h4>Public web sources</h4>
          <div className="ai-source-grid">
            {webSources.map((source) => {
              const url = safeExternalUrl(source.url);
              return (
                <article className="ai-source-card web" key={source.id || source.url}>
                  <div className="ai-source-card-heading"><span>{source.id}</span><strong>{source.title}</strong></div>
                  <small>{source.domain || "Public source"}{source.publishedAt ? ` · ${new Date(source.publishedAt).toLocaleDateString()}` : ""}</small>
                  {source.snippet && <p>{source.snippet}</p>}
                  {url && <a href={url} target="_blank" rel="noreferrer noopener">Open source <span aria-hidden="true">↗</span></a>}
                </article>
              );
            })}
          </div>
        </section>
      )}
      {!localSources.length && !webSources.length && <div className="ai-no-source" role="status">No reliable source found.</div>}
    </div>
  );
}

export function FeedbackButtons({ value, onChange }) {
  return (
    <div className="ai-feedback" aria-label="Answer feedback">
      <span>Was this helpful?</span>
      <button type="button" className={value === true ? "selected" : ""} aria-pressed={value === true} onClick={() => onChange(true)}>Helpful</button>
      <button type="button" className={value === false ? "selected" : ""} aria-pressed={value === false} onClick={() => onChange(false)}>Not helpful</button>
    </div>
  );
}
