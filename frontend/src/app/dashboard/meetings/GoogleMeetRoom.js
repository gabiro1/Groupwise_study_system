"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * External-link video room (Google Meet).
 *
 * Unlike Jitsi there is no iframe: the member's click opens the leader's Meet
 * link in a new tab, where Google handles sign-in and device permissions.
 * TWIGANE never touches the camera or microphone. Attendance follows the same
 * verifiable-only ledger as Jitsi: the open is recorded when the member clicks
 * through, the close when they press Leave or the page unloads (sendBeacon) —
 * nothing about the call itself is observable from here, so nothing is claimed.
 */
export default function GoogleMeetRoom({ joinConfig, meeting, onJoined, onLeft }) {
  const [opened, setOpened] = useState(false);
  const joinedRef = useRef(false);
  const leftRef = useRef(false);

  const reportLeave = useCallback(() => {
    if (!joinedRef.current || leftRef.current) return;
    leftRef.current = true;
    try {
      fetch(`/api/meetings/${meeting.id}/attendance/leave`, { method: "POST" }).catch(() => {});
    } catch { /* best-effort */ }
    setOpened(false);
    onLeft?.();
  }, [meeting.id, onLeft]);

  function openMeet() {
    window.open(joinConfig.joinUrl, "_blank", "noopener,noreferrer");
    if (!joinedRef.current) {
      joinedRef.current = true;
      try { fetch(`/api/meetings/${meeting.id}/attendance/join`, { method: "POST" }).catch(() => {}); } catch { /* best-effort */ }
    }
    setOpened(true);
    onJoined?.();
  }

  useEffect(() => {
    function handleUnload() {
      if (!joinedRef.current || leftRef.current) return;
      try {
        navigator.sendBeacon?.(
          `/api/meetings/${meeting.id}/attendance/leave`,
          new Blob(["{}"], { type: "application/json" }),
        );
      } catch { /* best-effort */ }
    }
    window.addEventListener("pagehide", handleUnload);
    window.addEventListener("beforeunload", handleUnload);
    return () => {
      window.removeEventListener("pagehide", handleUnload);
      window.removeEventListener("beforeunload", handleUnload);
    };
  }, [meeting.id]);

  return (
    <div className="google-meet-room">
      <p className="meeting-hint">
        This meeting runs on Google Meet and opens in a new tab — TWIGANE never
        asks for your camera or microphone.
      </p>
      <div className="workspace-create-actions">
        <button className="button button-primary" type="button" onClick={openMeet}>
          {opened ? "Open Google Meet again" : "Open Google Meet"}
        </button>
        {opened && (
          <button className="button button-secondary" type="button" onClick={reportLeave}>
            Leave meeting
          </button>
        )}
      </div>
      {opened && (
        <p className="feature-success" role="status">
          Google Meet opened in a new tab. Your attendance is recorded from the moment you
          clicked — close the Meet tab whenever you leave, then press Leave here.
        </p>
      )}
    </div>
  );
}
