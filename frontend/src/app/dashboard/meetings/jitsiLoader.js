"use client";

/**
 * Lazy loader for the Jitsi Meet External API (https://jitsi.org/api/).
 *
 * The script is fetched ONLY when a user opens the live-meeting page — never
 * on the dashboard — so an outage or slow provider cannot break the rest of
 * TWIGANE. Resolves with the `JitsiMeetExternalAPI` constructor, or rejects
 * with a descriptive error the UI turns into an empty/retry state.
 */

let cachedPromise = null;

function scriptUrl(domain) {
  return `https://${domain}/external_api.js`;
}

export function loadJitsiApi(domain) {
  if (typeof window === "undefined") return Promise.reject(new Error("Video meetings need a browser."));
  if (window.JitsiMeetExternalAPI) return Promise.resolve(window.JitsiMeetExternalAPI);
  if (cachedPromise) return cachedPromise;

  cachedPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = scriptUrl(domain);
    script.async = true;
    script.crossOrigin = "anonymous";
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error("The video service is taking too long to respond. Check your connection and retry."));
    }, 20000);

    function cleanup() {
      window.clearTimeout(timeout);
      script.removeEventListener("load", onLoad);
      script.removeEventListener("error", onError);
    }
    function onLoad() {
      cleanup();
      if (window.JitsiMeetExternalAPI) resolve(window.JitsiMeetExternalAPI);
      else {
        cachedPromise = null;
        reject(new Error("The video service loaded but did not initialise. Please retry."));
      }
    }
    function onError() {
      cleanup();
      cachedPromise = null;
      reject(new Error("Could not reach the video service. Check your connection, then retry."));
    }
    script.addEventListener("load", onLoad);
    script.addEventListener("error", onError);
    document.head.appendChild(script);
  });

  return cachedPromise;
}

export function resetJitsiLoader() {
  cachedPromise = null;
}
