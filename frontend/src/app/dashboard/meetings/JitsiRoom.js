"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { loadJitsiApi } from "./jitsiLoader";

const STATUS_LABEL = {
  idle: "Preparing your meeting…",
  loading: "Connecting to the video service…",
  joining: "Joining the room…",
  inCall: "Connected",
  error: "Connection issue",
};

export default function JitsiRoom({ joinConfig, meeting, onJoined, onLeft }) {
  const mountRef = useRef(null);
  const apiRef = useRef(null);
  const [status, setStatus] = useState("idle");
  const [error, setError] = useState("");
  const [participantCount, setParticipantCount] = useState(0);
  const [unsupported, setUnsupported] = useState("");
  // Mirrored from the iframe so the TWIGANE control bar stays in sync no
  // matter which side (our bar or Jitsi's own toolbar) flipped a setting.
  const [media, setMedia] = useState({ audioMuted: false, videoMuted: false, sharing: false, tileView: false });
  const joinedRef = useRef(false);
  const leftRef = useRef(false);
  // Monotonic token: only the latest join attempt may create the iframe, so a
  // retry or StrictMode remount can never spawn a duplicate connection.
  const joinSeq = useRef(0);

  const dispose = useCallback(() => {
    joinSeq.current += 1; // invalidate any in-flight join
    try { apiRef.current?.dispose(); } catch { /* gone */ }
    apiRef.current = null;
    if (mountRef.current) mountRef.current.innerHTML = "";
  }, []);

  const reportLeave = useCallback(() => {
    if (leftRef.current) return;
    leftRef.current = true;
    try {
      fetch(`/api/meetings/${meeting.id}/attendance/leave`, { method: "POST" }).catch(() => {});
    } catch { /* best-effort */ }
    onLeft?.();
  }, [meeting.id, onLeft]);
  const join = useCallback(async () => {
    if (!joinConfig || apiRef.current) return;
    const seq = ++joinSeq.current; // claim this attempt; older ones become stale
    setError("");
    if (!navigator.mediaDevices?.getUserMedia) {
      setUnsupported("This browser cannot access a camera or microphone. Use a recent Chrome, Edge, Firefox or Safari for audio and video.");
    }
    setStatus("loading");
    try {
      const JitsiMeetExternalAPI = await loadJitsiApi(joinConfig.domain);
      if (seq !== joinSeq.current || !mountRef.current) return; // superseded or unmounted
      setStatus("joining");
      const api = new JitsiMeetExternalAPI(joinConfig.domain, {
        roomName: joinConfig.roomName,
        parentNode: mountRef.current,
        width: "100%",
        height: "100%",
        userInfo: { displayName: joinConfig.displayName },
        configOverwrite: {
          startWithAudioMuted: false,
          startWithVideoMuted: false,
          enableWelcomePage: false,
          // No prejoin screen: the member's name comes from their TWIGANE
          // account via userInfo, so they join straight into the call with
          // one click instead of confirming a name every time. The browser
          // itself still asks for camera/mic permission on first use.
          prejoinPageEnabled: false,
          disableDeepLinking: true,
        },
        interfaceConfigOverwrite: { SHOW_JITSI_WATERMARK: false, SHOW_WATERMARK_FOR_GUESTS: false },
      });
      apiRef.current = api;
      // Keep the control bar state truthful even when the user toggles from
      // Jitsi's own toolbar instead of ours.
      api.addEventListener("audioMuteStatusChanged", (e) => setMedia((m) => ({ ...m, audioMuted: !!e?.muted })));
      api.addEventListener("videoMuteStatusChanged", (e) => setMedia((m) => ({ ...m, videoMuted: !!e?.muted })));
      api.addEventListener("screenSharingStatusChanged", (e) => setMedia((m) => ({ ...m, sharing: !!e?.on })));
      api.addEventListener("tileViewChanged", (e) => setMedia((m) => ({ ...m, tileView: !!e?.tileView })));
      api.addEventListener("videoConferenceJoined", () => {
        joinedRef.current = true;
        setStatus("inCall");
        setError("");
        try { fetch(`/api/meetings/${meeting.id}/attendance/join`, { method: "POST" }).catch(() => {}); } catch { /* noop */ }
        onJoined?.();
      });
      api.addEventListener("participantJoined", () => setParticipantCount((c) => c + 1));
      api.addEventListener("participantLeft", () => setParticipantCount((c) => Math.max(0, c - 1)));
      api.addEventListener("connectionFailed", () => {
        setStatus("error");
        setError("The video connection failed. Check your network, then rejoin.");
      });
      api.addEventListener("videoConferenceLeft", () => reportLeave());
      api.addEventListener("readyToClose", () => reportLeave());
    } catch (loadError) {
      setStatus("error");
      setError(loadError.message || "The video service could not be reached.");
    }
  }, [joinConfig, meeting.id, onJoined, reportLeave]);

  const joinKey = `${joinConfig?.roomName || ""}|${joinConfig?.domain || ""}`;

  useEffect(() => () => { dispose(); }, [dispose]);

  // Auto-join on mount. This component only ever mounts *after* the member has
  // clicked the page-level join button (MeetingDetail only sets joinConfig on
  // that click), so the browser's camera/mic permission prompt still follows a
  // deliberate action — there is no permission request on plain page load. The
  // seq guard inside join() makes React StrictMode's double-mount safe.
  useEffect(() => {
    if (!joinConfig) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- join once when the room mounts
    join().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps -- join once per room
  }, [joinKey]);

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

  function leave() {
    try { apiRef.current?.executeCommand("hangup"); } catch { /* noop */ }
    dispose();
    reportLeave();
  }

  /** Fire a Jitsi command; harmless no-op if the iframe is not up yet. */
  function runCommand(name, ...args) {
    try { apiRef.current?.executeCommand(name, ...args); } catch { /* noop */ }
  }
  return (
    <div className="jitsi-room">
      <div className="jitsi-statusbar" role="status" aria-live="polite">
        <span className={`meeting-dot ${status === "inCall" ? "live" : status === "error" ? "down" : "idle"}`} aria-hidden />
        <span>{STATUS_LABEL[status] || status}</span>
        {status === "inCall" && participantCount > 0 && (
          <span className="jitsi-count"> · {participantCount} other{participantCount === 1 ? "" : "s"}</span>
        )}
      </div>
      {unsupported && <p className="workspace-create-error" role="note">{unsupported}</p>}
      {status !== "inCall" && !error && (
        <div className="meeting-skeleton" aria-hidden>
          <div className="skeleton-tile" />
          <div className="skeleton-tile" />
          <div className="skeleton-tile" />
        </div>
      )}
      {error && (
        <div className="meeting-error" role="alert">
          <p><strong>Video unavailable.</strong> {error}</p>
          <p className="meeting-hint">
            Camera or microphone blocked? Look for the camera icon in your browser address bar,
            allow access for this site, then rejoin. Screen sharing needs a desktop browser.
          </p>
          <div className="workspace-create-actions">
            <button className="button button-primary" type="button" onClick={() => { dispose(); leftRef.current = false; setStatus("idle"); join(); }}>
              Retry connection
            </button>
            <button className="button button-secondary" type="button" onClick={leave}>
              Leave meeting
            </button>
          </div>
        </div>
      )}
      <div ref={mountRef} className="jitsi-mount" aria-label={`Video room for ${meeting.title}`} />
      {status === "inCall" && (
        <>
          <div className="jitsi-controls" role="toolbar" aria-label="Meeting controls">
            <button
              type="button"
              className={`jitsi-ctl ${media.audioMuted ? "off" : ""}`}
              aria-pressed={media.audioMuted}
              onClick={() => runCommand("toggleAudio")}
            >
              {media.audioMuted ? "🔇 Mic off" : "🎙 Mic on"}
            </button>
            <button
              type="button"
              className={`jitsi-ctl ${media.videoMuted ? "off" : ""}`}
              aria-pressed={media.videoMuted}
              onClick={() => runCommand("toggleVideo")}
            >
              {media.videoMuted ? "📷 Camera off" : "🎥 Camera on"}
            </button>
            <button
              type="button"
              className={`jitsi-ctl ${media.sharing ? "on" : ""}`}
              aria-pressed={media.sharing}
              onClick={() => runCommand("toggleShareScreen")}
            >
              {media.sharing ? "Stop sharing" : "Share screen"}
            </button>
            <button type="button" className="jitsi-ctl" onClick={() => runCommand("toggleVirtualBackgroundDialog")}>
              Background
            </button>
            <button
              type="button"
              className={`jitsi-ctl ${media.tileView ? "on" : ""}`}
              aria-pressed={media.tileView}
              onClick={() => runCommand("toggleTileView")}
            >
              {media.tileView ? "Grid view" : "Speaker view"}
            </button>
            <button type="button" className="jitsi-ctl" onClick={() => runCommand("toggleSubtitles")}>
              Captions
            </button>
            <button type="button" className="jitsi-ctl" onClick={() => runCommand("toggleRaiseHand")}>
              Raise hand
            </button>
            <span className="jitsi-ctl-spacer" aria-hidden />
            <button className="button button-secondary jitsi-ctl-leave" type="button" onClick={leave}>
              Leave meeting
            </button>
          </div>
          <p className="meeting-hint">
            Mic, camera, screen share and background effects work from this bar — or from Jitsi&apos;s own toolbar
            inside the room (including the ⚙ settings for choosing which microphone or camera to use).
            Leaving records your attendance and keeps the meeting running for others.
          </p>
        </>
      )}
    </div>
  );
}
