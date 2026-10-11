"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import BrandLogo from "./BrandLogo";
import { SiteFooter, SiteHeader } from "./SiteLayout";

function PasswordField({ name, autoComplete, required = false, minLength, maxLength }) {
  const [visible, setVisible] = useState(false);

  return (
    <div className="auth-password-field">
      <input
        id={`auth-${name}`}
        name={name}
        type={visible ? "text" : "password"}
        autoComplete={autoComplete}
        minLength={minLength}
        maxLength={maxLength}
        required={required}
      />
      <button
        className="auth-password-toggle"
        type="button"
        aria-label={visible ? "Hide password" : "Show password"}
        aria-pressed={visible}
        aria-controls={`auth-${name}`}
        onClick={() => setVisible((shown) => !shown)}
      >
        {visible ? (
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="m3 3 18 18M10.6 10.6a2 2 0 0 0 2.8 2.8" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
            <path d="M9.9 5.2A10.7 10.7 0 0 1 12 5c5.2 0 9 5 9 7s-1 2.7-2.5 4.2M6.2 6.2C3.5 7.9 2 10.6 2 12c0 2 3.8 7 10 7 1.2 0 2.3-.2 3.3-.6" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7Z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
            <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.7" />
          </svg>
        )}
      </button>
    </div>
  );
}

async function request(path, options) {
  if (options?.method && options.method !== "GET") {
    const csrfResponse = await fetch("/api/auth/csrf", { cache: "no-store" });
    if (!csrfResponse.ok) {
      throw new Error("We couldn’t verify this request. Please refresh and try again.");
    }
  }
  const response = await fetch(`/api/${path}`, {
    cache: "no-store",
    ...options,
    headers: {
      ...(options?.body ? { "content-type": "application/json" } : {}),
      ...options?.headers,
    },
  });
  const result = response.status === 204 ? {} : await response.json();
  if (!response.ok) {
    const error = new Error(result.error?.message || "We couldn’t complete that request.");
    error.fields = result.error?.fields || {};
    error.code = result.error?.code || "";
    throw error;
  }
  return result.data;
}

function AuthFrame({ title, description, children, footer, siteChrome = false }) {
  return (
    <main className={`auth-page${siteChrome ? " auth-page-with-site-chrome" : ""}`}>
      {siteChrome ? <SiteHeader /> : (
        <header className="auth-header">
          <Link className="landing-brand" href="/" aria-label="Lien home">
            <BrandLogo className="lien-logo" />
          </Link>
          <Link href="/about">Learn about Lien</Link>
        </header>
      )}
      <section className="auth-card">
        <div className="auth-heading"><span>YOUR STUDY SPACE</span><h1>{title}</h1><p>{description}</p></div>
        {children}
        <div className="auth-card-footer">{footer}</div>
      </section>
      {siteChrome
        ? <SiteFooter />
        : <footer className="auth-footer">Your courses. Your people. Better learning together.</footer>}
    </main>
  );
}

export function LoginForm({ nextPath = "/dashboard" }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [fields, setFields] = useState({});
  const [unverifiedEmail, setUnverifiedEmail] = useState("");

  async function handleSubmit(event) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setLoading(true);
    setError("");
    setFields({});
    setUnverifiedEmail("");
    try {
      const result = await request("auth/login", {
        method: "POST",
        body: JSON.stringify({
          email: form.get("email"),
          password: form.get("password"),
          rememberDevice: form.get("rememberDevice") === "on",
        }),
      });
      const role = result?.user?.role;
      let destination = nextPath.startsWith("/dashboard") ? nextPath : "/dashboard";
      if (role === "ADMIN") destination = "/admin";
      window.location.assign(new URL(destination, window.location.href));
    } catch (submitError) {
      setError(submitError.message);
      setFields(submitError.fields || {});
      if (submitError.code === "EMAIL_NOT_VERIFIED") {
        setUnverifiedEmail(String(form.get("email") || ""));
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <AuthFrame
      title="Welcome back."
      description="Sign in to pick up where your study group left off."
      siteChrome
      footer={<>New to Lien? <Link href="/register">Create a student account</Link></>}
    >
      <form className="auth-form" onSubmit={handleSubmit}>
        {error && <div className="auth-alert" role="alert">{error}{unverifiedEmail && <> <Link href={`/resend-verification?email=${encodeURIComponent(unverifiedEmail)}`}>Resend verification link</Link></>}</div>}
        <label><span>Email address</span><input name="email" type="email" autoComplete="email" required />{fields.email && <small>{fields.email}</small>}</label>
        <label><span>Password</span><PasswordField name="password" autoComplete="current-password" required />{fields.password && <small>{fields.password}</small>}</label>
        <div className="auth-form-options"><label className="auth-checkbox"><input name="rememberDevice" type="checkbox" defaultChecked /><span>Keep me signed in</span></label><Link href="/forgot-password">Forgot password?</Link></div>
        <button className="landing-primary-button auth-submit" type="submit" disabled={loading}>{loading ? "Signing in…" : "Sign in"} <span aria-hidden="true">↗</span></button>
      </form>
    </AuthFrame>
  );
}

export function RegisterForm() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [fields, setFields] = useState({});

  async function handleSubmit(event) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    if (form.get("password") !== form.get("confirmPassword")) {
      setError("Passwords do not match.");
      setFields({ confirmPassword: "Enter the same password in both fields." });
      return;
    }
    setLoading(true);
    setError("");
    setFields({});
    try {
      await request("auth/register", {
        method: "POST",
        body: JSON.stringify({
          firstName: form.get("firstName"),
          lastName: form.get("lastName"),
          email: form.get("email"),
          password: form.get("password"),
          acceptTerms: form.get("acceptTerms") === "on",
        }),
      });
      window.location.assign(new URL("/dashboard", window.location.href));
    } catch (submitError) {
      setError(submitError.message);
      setFields(submitError.fields || {});
    } finally {
      setLoading(false);
    }
  }

  return (
    <AuthFrame title="Create your study space." description="Set up your student account to find groups and study with classmates." siteChrome footer={<>Already have an account? <Link href="/login">Sign in</Link></>}>
      <form className="auth-form register-form" onSubmit={handleSubmit}>
        {error && <div className="auth-alert" role="alert">{error}</div>}
        <div className="auth-name-row">
          <label><span>First name</span><input name="firstName" autoComplete="given-name" maxLength={60} required />{fields.firstName && <small>{fields.firstName}</small>}</label>
          <label><span>Last name</span><input name="lastName" autoComplete="family-name" maxLength={60} required />{fields.lastName && <small>{fields.lastName}</small>}</label>
        </div>
        <label><span>Email address</span><input name="email" type="email" autoComplete="email" maxLength={254} required />{fields.email && <small>{fields.email}</small>}</label>
        <label><span>Password</span><PasswordField name="password" autoComplete="new-password" minLength={10} maxLength={200} required /><small>At least 10 characters, with uppercase, lowercase, and a number.</small>{fields.password && <small>{fields.password}</small>}</label>
        <label><span>Confirm password</span><PasswordField name="confirmPassword" autoComplete="new-password" minLength={10} maxLength={200} required />{fields.confirmPassword && <small>{fields.confirmPassword}</small>}</label>
        <label className="auth-checkbox auth-terms"><input type="checkbox" name="acceptTerms" required /><span>I agree to use Lien respectfully and understand I can update my study profile later.</span></label>
        <button className="landing-primary-button auth-submit" type="submit" disabled={loading}>{loading ? "Creating account…" : "Create student account"} <span aria-hidden="true">↗</span></button>
      </form>
    </AuthFrame>
  );
}

export function VerificationResendForm({ initialEmail = "" }) {
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [developmentVerificationUrl, setDevelopmentVerificationUrl] = useState("");

  async function resend(event) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setLoading(true);
    setMessage("");
    setError("");
    setDevelopmentVerificationUrl("");
    try {
      const result = await request("auth/resend-verification", {
        method: "POST",
        body: JSON.stringify({ email: form.get("email") }),
      });
      setMessage(result.message);
      setDevelopmentVerificationUrl(result.developmentVerificationUrl || "");
    } catch (resendError) {
      setError(resendError.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <form className="auth-form" onSubmit={resend}>
      <label><span>Need another verification link?</span><input name="email" type="email" defaultValue={initialEmail} autoComplete="email" maxLength={254} required /></label>
      {message && <div className="auth-success-message" role="status">{message}{developmentVerificationUrl && <> <a href={developmentVerificationUrl}>Verify this account here</a></>}</div>}
      {error && <div className="auth-alert" role="alert">{error}</div>}
      <button className="landing-primary-button auth-submit" type="submit" disabled={loading}>{loading ? "Sending link…" : "Resend verification link"}</button>
    </form>
  );
}

export function VerifyEmailForm({ token = "" }) {
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const attemptedToken = useRef("");

  async function verifyToken(value) {
    setLoading(true);
    setMessage("");
    setError("");
    try {
      await request("auth/verify-email", {
        method: "POST",
        body: JSON.stringify({ token: value }),
      });
      setMessage("Your email is verified. You can now sign in.");
    } catch (verificationError) {
      setError(verificationError.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!token || attemptedToken.current === token) return;
    attemptedToken.current = token;
    void verifyToken(token);
    window.history.replaceState(null, "", "/verify-email");
  }, [token]);

  function verify(event) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    void verifyToken(form.get("token"));
  }

  return (
    <AuthFrame title="Verify your email." description="Confirm your email address to activate your Lien student account." footer={<>Ready to continue? <Link href="/login">Sign in</Link></>}>
      <form className="auth-form" onSubmit={verify}>
        {message && <div className="auth-success-message" role="status">{message} <Link href="/login">Sign in</Link></div>}
        {error && <div className="auth-alert" role="alert">{error}</div>}
        {!message && <label><span>Verification token</span><input name="token" defaultValue={token} minLength={10} required />{token && loading && <small>Verifying your email address…</small>}</label>}
        <button className="landing-primary-button auth-submit" disabled={loading || Boolean(message)}>{loading ? "Verifying…" : "Verify email"} <span aria-hidden="true">↗</span></button>
      </form>
    </AuthFrame>
  );
}

export function ForgotPasswordForm() {
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [developmentResetUrl, setDevelopmentResetUrl] = useState("");
  async function submit(event) {
    event.preventDefault();
    const email = new FormData(event.currentTarget).get("email");
    setLoading(true);
    setError("");
    setDevelopmentResetUrl("");
    try {
      const result = await request("auth/forgot-password", { method: "POST", body: JSON.stringify({ email }) });
      setMessage(result.message);
      setDevelopmentResetUrl(result.developmentResetUrl || "");
    } catch (submitError) {
      setError(submitError.message);
    } finally {
      setLoading(false);
    }
  }
  return (
    <AuthFrame title="Reset your password." description="Enter your account email and we’ll send a reset link if there’s an account for it." footer={<>Remembered it? <Link href="/login">Back to sign in</Link></>}>
      <form className="auth-form" onSubmit={submit}>
        {message && <div className="auth-success-message" role="status">{message}{developmentResetUrl && <> <a href={developmentResetUrl}>Reset your password here</a></>}</div>}
        {error && <div className="auth-alert" role="alert">{error}</div>}
        <label><span>Email address</span><input name="email" type="email" autoComplete="email" required /></label>
        <button className="landing-primary-button auth-submit" disabled={loading}>{loading ? "Sending…" : "Send reset link"} <span aria-hidden="true">↗</span></button>
      </form>
    </AuthFrame>
  );
}

export function ResetPasswordForm({ token = "" }) {
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  async function submit(event) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const password = form.get("password");
    if (password !== form.get("confirmPassword")) {
      setError("The passwords don’t match.");
      return;
    }
    setLoading(true);
    setError("");
    try {
      const result = await request("auth/reset-password", { method: "POST", body: JSON.stringify({ token: form.get("token"), password }) });
      setMessage(result.message);
    } catch (submitError) {
      setError(submitError.message);
    } finally {
      setLoading(false);
    }
  }
  return (
    <AuthFrame title="Choose a new password." description="Use at least 10 characters, including uppercase, lowercase, and a number." footer={<>Remembered your password? <Link href="/login">Sign in</Link></>}>
      <form className="auth-form" onSubmit={submit}>
        {message && <div className="auth-success-message" role="status">{message} <Link href="/login">Sign in</Link></div>}
        {error && <div className="auth-alert" role="alert">{error}</div>}
        <label><span>Reset token</span><input name="token" defaultValue={token} minLength={10} required /></label>
        <label><span>New password</span><PasswordField name="password" autoComplete="new-password" minLength={10} maxLength={200} required /></label>
        <label><span>Confirm new password</span><PasswordField name="confirmPassword" autoComplete="new-password" required /></label>
        <button className="landing-primary-button auth-submit" disabled={loading || Boolean(message)}>{loading ? "Updating…" : "Update password"} <span aria-hidden="true">↗</span></button>
      </form>
    </AuthFrame>
  );
}
