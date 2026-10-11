"use client";

import Link from "next/link";
import Image from "next/image";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import BrandLogo from "./BrandLogo";
import ThemeToggle from "./ThemeToggle";

function initialsFor(user) {
  return [user?.firstName, user?.lastName]
    .filter(Boolean)
    .map((name) => name[0])
    .join("")
    .slice(0, 2)
    .toUpperCase() || "S";
}

export default function SiteHeaderClient({ pages }) {
  const router = useRouter();
  const pathname = usePathname();
  const menuRef = useRef(null);
  const exploreRef = useRef(null);
  const [authState, setAuthState] = useState({ pathname: null, status: "loading", user: null });
  const [mobileOpen, setMobileOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [exploreOpen, setExploreOpen] = useState(false);
  const [failedAvatarUrl, setFailedAvatarUrl] = useState("");
  const [signOutError, setSignOutError] = useState("");

  useEffect(() => {
    let active = true;
    fetch("/api/auth/me", { cache: "no-store" })
      .then(async (response) => {
        if (response.status === 401) return { status: "unauthenticated", user: null };
        if (!response.ok) throw new Error("Could not verify the current session.");
        const result = await response.json();
        const currentUser = result.data?.user || null;
        return {
          status: currentUser ? "authenticated" : "unauthenticated",
          user: currentUser,
        };
      })
      .then(({ status, user: currentUser }) => {
        if (active) setAuthState({ pathname, status, user: currentUser });
      })
      .catch(() => {
        if (active) setAuthState({ pathname, status: "error", user: null });
      });
    return () => { active = false; };
  }, [pathname]);

  const authStatus = authState.pathname === pathname ? authState.status : "loading";
  const user = authStatus === "authenticated" ? authState.user : null;

  useEffect(() => {
    function closeOnOutsideClick(event) {
      if (!menuRef.current?.contains(event.target)) setProfileOpen(false);
      if (!exploreRef.current?.contains(event.target)) setExploreOpen(false);
    }
    function closeOnEscape(event) {
      if (event.key === "Escape") {
        setProfileOpen(false);
        setExploreOpen(false);
        setMobileOpen(false);
      }
    }
    document.addEventListener("pointerdown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, []);

  async function signOut() {
    setSignOutError("");
    try {
      const response = await fetch("/api/auth/logout", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      if (!response.ok) {
        const result = await response.json();
        throw new Error(result.error?.message || "We couldn’t sign you out. Please try again.");
      }
      setAuthState({ pathname, status: "unauthenticated", user: null });
      setProfileOpen(false);
      router.refresh();
    } catch (error) {
      setSignOutError(error.message || "We couldn’t sign you out. Please try again.");
    }
  }

  const initials = initialsFor(user);

  return (
    <header className="landing-nav">
      <Link className="landing-brand" href="/" aria-label="Lien home">
        <BrandLogo className="lien-logo" />
      </Link>

      <button
        className={`landing-menu-toggle ${mobileOpen ? "is-open" : ""}`}
        type="button"
        aria-label={mobileOpen ? "Close navigation menu" : "Open navigation menu"}
        aria-expanded={mobileOpen}
        aria-controls="site-navigation"
        onClick={() => setMobileOpen((open) => !open)}
      >
        <span />
        <span />
        <span />
      </button>

      <div className={`landing-nav-content ${mobileOpen ? "is-open" : ""}`} id="site-navigation">
        <nav className="landing-nav-links" aria-label="Main navigation">
          {pages.filter((page) => !["/how-it-works", "/faq"].includes(page.href)).map((page) => <Link href={page.href} key={page.href} onClick={() => setMobileOpen(false)}>{page.label}</Link>)}
          <div className={`landing-mega ${exploreOpen ? "is-open" : ""}`} ref={exploreRef}>
            <button
              className="landing-mega-trigger"
              type="button"
              aria-expanded={exploreOpen}
              aria-haspopup="true"
              onClick={() => setExploreOpen((open) => !open)}
            >
              Explore <span aria-hidden="true">⌄</span>
            </button>
            <div className="landing-mega-menu">
              <div className="landing-mega-intro">
                <span>EXPLORE LIEN</span>
                <strong>Everything you need to learn together.</strong>
              </div>
              <div className="landing-mega-links">
                <Link href="/#how-it-works" onClick={() => { setExploreOpen(false); setMobileOpen(false); }}>How it works<small>Get started in a few simple steps</small></Link>
                <Link href="/#features" onClick={() => { setExploreOpen(false); setMobileOpen(false); }}>Features<small>Find groups and plan your study time</small></Link>
                <Link href="/#ai-tutor" onClick={() => { setExploreOpen(false); setMobileOpen(false); }}>AI tutor<small>Get help with shared study material</small></Link>
                <Link href="/#study-tools" onClick={() => { setExploreOpen(false); setMobileOpen(false); }}>Study tools<small>Plans, tasks, sessions and resources</small></Link>
                <Link href="/dashboard" onClick={() => { setExploreOpen(false); setMobileOpen(false); }}>Progress<small>Continue to your study dashboard</small></Link>
                <Link href="/#testimonials" onClick={() => { setExploreOpen(false); setMobileOpen(false); }}>Testimonial<small>See what learning together can feel like</small></Link>
                <Link href="/#faq" onClick={() => { setExploreOpen(false); setMobileOpen(false); }}>FAQ<small>Answers to common questions</small></Link>
              </div>
            </div>
          </div>
          {authStatus === "authenticated" && <Link className="landing-mobile-dashboard" href="/dashboard" onClick={() => setMobileOpen(false)}>Your dashboard</Link>}
          {authStatus === "unauthenticated" && (
            <div className="landing-mobile-auth">
              <Link href="/login" onClick={() => setMobileOpen(false)}>Sign in</Link>
              <Link className="landing-mobile-signup" href="/register" onClick={() => setMobileOpen(false)}>Create account <span aria-hidden="true">↗</span></Link>
            </div>
          )}
        </nav>
        <div className="landing-nav-actions">
          <ThemeToggle />
          {authStatus === "authenticated" && user ? (
            <div className="site-profile" ref={menuRef}>
              <button
                className="site-profile-trigger"
                type="button"
                aria-label={`Open ${user.fullName || user.firstName || "your"} account menu`}
                aria-haspopup="true"
                aria-expanded={profileOpen}
                onClick={() => {
                  setSignOutError("");
                  setProfileOpen((open) => !open);
                }}
              >
                <span className="site-profile-avatar">
                  {user.avatarUrl && failedAvatarUrl !== user.avatarUrl
                    ? <Image src={user.avatarUrl} alt="" width={36} height={36} unoptimized referrerPolicy="no-referrer" onError={() => setFailedAvatarUrl(user.avatarUrl)} />
                    : initials}
                </span>
                <span className="site-profile-chevron" aria-hidden="true">⌄</span>
              </button>
              {profileOpen && (
                <div className="site-profile-menu">
                  <div className="site-profile-summary">
                    <strong>{user.fullName || user.firstName || "Student"}</strong>
                    <span>{user.email}</span>
                  </div>
                  <Link href="/dashboard" onClick={() => setProfileOpen(false)}>Open dashboard <span aria-hidden="true">↗</span></Link>
                  {signOutError && <p className="site-profile-error" role="alert">{signOutError}</p>}
                  <button type="button" onClick={signOut}>Sign out</button>
                </div>
              )}
            </div>
          ) : authStatus === "unauthenticated" ? (
            <>
              <Link className="landing-sign-in" href="/login">Sign in</Link>
              <Link className="landing-nav-cta landing-desktop-signup" href="/register">Create account <span aria-hidden="true">↗</span></Link>
            </>
          ) : (
            <span className="site-auth-status" role="status">
              {authStatus === "loading" ? "Checking account…" : "Account status unavailable"}
            </span>
          )}
        </div>
      </div>
    </header>
  );
}
