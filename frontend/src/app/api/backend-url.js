const PRODUCTION_BACKEND_URL = "https://groupwise-study-system.onrender.com";

const configured = (process.env.BACKEND_API_URL || "").trim().replace(/\/+$/, "");

export const backendUrl = /^https?:\/\//i.test(configured)
  ? configured
  : process.env.NODE_ENV === "production"
    ? PRODUCTION_BACKEND_URL
    // Use the IPv4 loopback explicitly. On systems where localhost resolves to
    // ::1 first, the backend may be listening on 0.0.0.0/IPv4 only and every
    // BFF request otherwise becomes a misleading 503.
    : "http://127.0.0.1:4000";
