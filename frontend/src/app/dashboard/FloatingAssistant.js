"use client";

import { useEffect, useRef, useState } from "react";
import { getAiStatus, askAssistant } from "./aiClient";

function BubbleIcon({ size = 22 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20 11.5a7.5 7.5 0 0 1-7.5 7.5H6l-3 2v-9.5A7.5 7.5 0 0 1 10.5 4h2A7.5 7.5 0 0 1 20 11.5Z" />
      <path d="M8 11h8M8 14h5" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m18 6-12 12M6 6l12 12" />
    </svg>
  );
}

function SendIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M22 2 11 13" /><path d="M22 2 15 22l-4-9-9-4Z" />
    </svg>
  );
}

/**
 * Floating, grounded study assistant.
 *
 * It answers from every resource the student can already read (all their courses
 * and group workspaces) plus a factual snapshot of their platform activity, and
 * cites the material it used. When no provider is configured the bubble is still
 * offered but the panel explains how to switch AI on instead of failing.
 */
export default function FloatingAssistant() {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState(null);
  const [statusLoaded, setStatusLoaded] = useState(false);
  const [messages, setMessages] = useState([
    {
      role: "assistant",
      content: "Hi! I’m your Lien study assistant. Ask me about your courses, groups, partners, or anything your group has shared.",
      sources: [],
    },
  ]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const scrollRef = useRef(null);

  useEffect(() => {
    let active = true;
    getAiStatus()
      .then((data) => { if (active) setStatus(data.ai || null); })
      .catch(() => { if (active) setStatus(null); })
      .finally(() => { if (active) setStatusLoaded(true); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (open && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, open, busy]);

  const configured = status?.configured !== false;

  async function send(event) {
    event.preventDefault();
    const question = input.trim();
    if (!question || busy) return;
    setMessages((current) => [...current, { role: "user", content: question }]);
    setInput("");
    setBusy(true);
    setError("");
    try {
      const response = await askAssistant({ message: question });
      if (response.available === false) {
        setStatus((current) => (current ? { ...current, configured: false } : { configured: false }));
        setMessages((current) => [...current, {
          role: "assistant",
          content: response.message || "The assistant is unavailable right now.",
          sources: [],
        }]);
        return;
      }
      setMessages((current) => [...current, {
        role: "assistant",
        content: response.answer || response.message || "I couldn’t find anything in your material that answers that.",
        sources: response.sources || [],
      }]);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={`floating-assistant ${open ? "open" : ""}`}>
      {open && (
        <section className="floating-assistant-panel" role="dialog" aria-label="Lien study assistant">
          <header className="floating-assistant-head">
            <div>
              <strong>Lien study assistant</strong>
              <small>{configured ? "Answers from your study material" : "Assistant is off"}</small>
            </div>
            <button type="button" className="floating-assistant-close" aria-label="Close assistant" onClick={() => setOpen(false)}>
              <CloseIcon />
            </button>
          </header>

          {!configured && statusLoaded && (
            <div className="floating-assistant-off" role="status">
              <p>The assistant needs an AI provider and API key to answer. Everything else still works.</p>
              <small>Set <code>AI_PROVIDER</code> and <code>AI_API_KEY</code> on the server, then reload.</small>
            </div>
          )}

          <div className="floating-assistant-messages" ref={scrollRef}>
            {messages.map((message, index) => (
              <article className={`workspace-message ${message.role}`} key={`${message.role}-${index}`}>
                <strong>{message.role === "user" ? "You" : "Lien study assistant"}</strong>
                <p>{message.content}</p>
                {message.sources?.map((source) => (
                  <small className="ai-source" key={source.resourceId}>
                    Source: {source.title}{source.excerpt ? ` — “${source.excerpt}”` : ""}
                  </small>
                ))}
              </article>
            ))}
            {busy && <article className="workspace-message assistant"><strong>Lien study assistant</strong><p>Looking through your material…</p></article>}
          </div>

          {error && <div className="feature-error" role="alert">{error}</div>}

          <form className="workspace-message-form floating-assistant-form" onSubmit={send}>
            <label className="sr-only" htmlFor="floating-assistant-input">Ask the assistant</label>
            <textarea
              id="floating-assistant-input"
              rows={2}
              maxLength={2000}
              value={input}
              onChange={(event) => setInput(event.target.value)}
              placeholder="Ask a question about your studies…"
            />
            <button className="button button-primary floating-assistant-send" type="submit" disabled={busy || !input.trim()} aria-label="Send">
              <SendIcon />
            </button>
          </form>
        </section>
      )}

      <button
        type="button"
        className="floating-assistant-bubble"
        aria-label={open ? "Close study assistant" : "Ask the study assistant"}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {open ? <CloseIcon /> : <BubbleIcon />}
        {!open && <span className="floating-assistant-label">Ask AI</span>}
      </button>
    </div>
  );
}
