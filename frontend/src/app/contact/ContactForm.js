"use client";

import { useCallback, useEffect, useState } from "react";

export default function ContactForm() {
  const [csrfToken, setCsrfToken] = useState("");
  const [loadingToken, setLoadingToken] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [fieldErrors, setFieldErrors] = useState({});
  const [sent, setSent] = useState(false);

  const requestCsrfToken = useCallback(async () => {
    const response = await fetch("/api/contact", { cache: "no-store" });
    const result = await response.json();
    if (!response.ok || !result.data?.csrfToken) {
      throw new Error(result.error?.message || "The contact form couldn’t be loaded. Please try again.");
    }
    return result.data.csrfToken;
  }, []);

  useEffect(() => {
    let active = true;
    requestCsrfToken()
      .then((token) => {
        if (active) setCsrfToken(token);
      })
      .catch((loadError) => {
        if (active) setError(loadError.message || "The contact form couldn’t be loaded. Please try again.");
      })
      .finally(() => {
        if (active) setLoadingToken(false);
      });
    return () => {
      active = false;
    };
  }, [requestCsrfToken]);

  async function retryCsrfToken() {
    setLoadingToken(true);
    setError("");
    try {
      setCsrfToken(await requestCsrfToken());
    } catch (loadError) {
      setError(loadError.message || "The contact form couldn’t be loaded. Please try again.");
    } finally {
      setLoadingToken(false);
    }
  }

  async function handleSubmit(event) {
    event.preventDefault();
    const form = event.currentTarget;
    setSending(true);
    setError("");
    setFieldErrors({});
    try {
      const formData = new FormData(event.currentTarget);
      const response = await fetch("/api/contact", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(Object.fromEntries(formData.entries())),
      });
      const result = await response.json();
      if (!response.ok) {
        setFieldErrors(result.error?.fields || {});
        throw new Error(result.error?.message || "Your message couldn’t be sent. Please try again.");
      }
      setSent(true);
      form.reset();
    } catch (submitError) {
      setError(submitError.message || "Your message couldn’t be sent. Please try again.");
    } finally {
      setSending(false);
    }
  }

  if (sent) {
    return (
      <div className="contact-success" role="status">
        <span aria-hidden="true">✓</span>
        <h2>Your message is on its way.</h2>
        <p>Thanks for getting in touch. We’ll get back to you as soon as we can.</p>
        <button type="button" className="contact-reset" onClick={() => setSent(false)}>Send another message</button>
      </div>
    );
  }

  return (
    <form className="contact-form" onSubmit={handleSubmit}>
      <div className="contact-form-row">
        <label>
          <span>Your name</span>
          <input name="name" autoComplete="name" maxLength={60} required />
          {fieldErrors.name && <small className="contact-field-error">{fieldErrors.name}</small>}
        </label>
        <label>
          <span>Email address</span>
          <input name="email" type="email" autoComplete="email" maxLength={254} required />
          {fieldErrors.email && <small className="contact-field-error">{fieldErrors.email}</small>}
        </label>
      </div>
      <label>
        <span>Subject</span>
        <input name="subject" maxLength={120} required />
        {fieldErrors.subject && <small className="contact-field-error">{fieldErrors.subject}</small>}
      </label>
      <label>
        <span>Your message</span>
        <textarea name="message" rows={6} minLength={10} maxLength={5000} required />
        {fieldErrors.message && <small className="contact-field-error">{fieldErrors.message}</small>}
      </label>
      {error && (
        <div className="contact-form-error" role="alert">
          <p>{error}</p>
          {!csrfToken && !loadingToken && <button type="button" onClick={retryCsrfToken}>Try loading the form again</button>}
        </div>
      )}
      <button className="landing-primary-button contact-submit" type="submit" disabled={sending || loadingToken || !csrfToken}>
        {loadingToken ? "Preparing form…" : sending ? "Sending…" : "Send message"} <span aria-hidden="true">↗</span>
      </button>
      <p className="contact-form-note">Your message will be sent to our support team. Please don’t include passwords or other sensitive account credentials.</p>
    </form>
  );
}
