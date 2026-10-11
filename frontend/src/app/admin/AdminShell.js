"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import AdminSidebar from "./AdminSidebar";
import AdminHeader from "./AdminHeader";
import { apiRequest, displayName } from "./adminApi";
import { Skeleton } from "./DataState";

/**
 * Client shell for every `/admin/*` route.
 *
 * The whole area is gated here in one place. The API enforces `requireAdmin`
 * regardless — this gate is for the user's benefit (a clear message instead of a
 * wall of failed requests), not as the security boundary.
 */
export default function AdminShell({ children }) {
  const [status, setStatus] = useState("loading");
  const [user, setUser] = useState(null);
  const [system, setSystem] = useState(null);
  const [navOpen, setNavOpen] = useState(false);
  const pathname = usePathname();
  const router = useRouter();

  useEffect(() => {
    let active = true;

    (async () => {
      try {
        const me = await apiRequest("auth/me");
        if (!active) return;

        if (!me?.user) {
          router.replace(`/login?next=${encodeURIComponent(pathname)}`);
          return;
        }

        setUser(me.user);

        if (me.user.role !== "ADMIN") {
          setStatus("denied");
          return;
        }

        setStatus("ok");
        apiRequest("admin/system")
          .then((result) => {
            if (active) setSystem(result);
          })
          .catch(() => {
            if (active) setSystem({ status: "unknown" });
          });
      } catch (error) {
        if (!active) return;
        if (error.status === 401) {
          router.replace(`/login?next=${encodeURIComponent(pathname)}`);
        } else {
          setStatus("error");
        }
      }
    })();

    return () => {
      active = false;
    };
  }, [router, pathname]);

  if (status === "loading") {
    return (
      <div className="admin-shell admin-shell-loading" aria-busy="true">
        <Skeleton rows={6} />
      </div>
    );
  }

  if (status === "error") {
    return (
      <div className="admin-denied">
        <div className="admin-denied-card">
          <h1>We could not load the admin console</h1>
          <p>Something went wrong checking your session. Please try again.</p>
          <div className="admin-denied-actions">
            <button type="button" className="admin-btn admin-btn-primary" onClick={() => window.location.reload()}>
              Reload
            </button>
            <Link className="admin-btn admin-btn-ghost" href="/dashboard">
              Go to dashboard
            </Link>
          </div>
        </div>
      </div>
    );
  }

  if (status === "denied") {
    return (
      <div className="admin-denied">
        <div className="admin-denied-card">
          <h1>Admin access required</h1>
          <p>
            {user
              ? `${displayName(user)} is signed in, but this area is reserved for administrators.`
              : "You need an administrator account to open the admin console."}
          </p>
          <div className="admin-denied-actions">
            <Link className="admin-btn admin-btn-primary" href="/dashboard">
              Go to dashboard
            </Link>
            <Link className="admin-btn admin-btn-ghost" href="/login">
              Sign in as another account
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={`admin-shell${navOpen ? " admin-nav-open" : ""}`}>
      <AdminSidebar user={user} system={system} onNavigate={() => setNavOpen(false)} />
      <div className="admin-main">
        <AdminHeader onOpenNav={() => setNavOpen(true)} />
        <main className="admin-content">{children}</main>
      </div>
      <button
        type="button"
        className="admin-scrim"
        aria-label="Close navigation"
        tabIndex={navOpen ? 0 : -1}
        onClick={() => setNavOpen(false)}
      />
    </div>
  );
}
