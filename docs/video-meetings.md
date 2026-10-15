# Video Meetings (Jitsi + Google Meet)

TWIGANE study groups can schedule and run video meetings. Scheduling,
permissions and attendance live in the Postgres database and the Express API;
the video itself comes from one of two providers:

- **Jitsi** — a private room embedded in the dashboard through the official
  IFrame external API (default).
- **Google Meet** — the leader pastes their own `meet.google.com` link when
  scheduling; members open it in a new tab with one click. TWIGANE never asks
  for camera/microphone permission on this path — Google handles sign-in and
  devices on its own page.

```
┌────────────┐   REST (Bearer JWT)   ┌──────────────┐    SQL     ┌────────────┐
│  Next.js   │ ────────────────────▶ │  Express API  │ ─────────▶ │ PostgreSQL │
│  dashboard │ ◀──────────────────── │  /api/meetings│            │ group_     │
│  JitsiRoom │                       └──────┬────────┘            │ meetings   │
│  (iframe)  │                              │ JITSI_DOMAIN        │ meeting_   │
└─────┬──────┘                              ▼                     │ attendance │
      │                          ┌──────────────────┐            └────────────┘
      └─────────────────────────▶│  Jitsi Meet       │
          external_api.js        │  (meet.jit.si or  │
                                 │  self-hosted/JaaS)│
                                 └──────────────────┘
```

## What is implemented

- **Scheduling** — group owners/moderators create meetings with a title,
  optional description, and a start/end time. Overlapping meetings in the same
  group are rejected by a database trigger (`MEETING_OVERLAP` → HTTP 409).
- **Lifecycle** — `SCHEDULED → LIVE → COMPLETED` plus `CANCELLED`. A leader
  joining a `SCHEDULED` meeting inside the join window auto-starts it
  (sets `started_at`, status `LIVE`). Completing/cancelling is leader-only.
- **Join window** — members may join from `MEETING_JOIN_WINDOW_MINUTES`
  (default 15) minutes before the scheduled start until it ends. Outside the
  window the API refuses with a clear error and the UI shows the window.
- **Attendance ledger** — every join/leave is recorded in `meeting_attendance`.
  Joins are idempotent (`duplicate: true` on repeat), leaves close the open row
  (`left_at`), and the browser uses `sendBeacon` on unload so refreshing or
  closing the tab still records the leave. Leaders can view per-meeting
  attendance; everyone can fetch their own history.
- **Permissions** — all routes require an authenticated student/leader session.
  Authorisation is always re-derived from group membership in the service
  layer; a client-supplied group id is never trusted. Outsiders get 403/404,
  never meeting data.
- **Frontend** — `/dashboard/meetings` lists the caller's meetings;
  `/dashboard/meetings/[meetingId]` shows details, join/leave controls, the
  live Jitsi iframe (loaded as soon as the member clicks the page-level join
  button — the single consent point for camera/mic, never on plain page load —
  and it auto-connects from there, so one click puts you in the call) or — for
  Google Meet meetings — a single "Open Google Meet" button that opens the
  leader's link in a new tab (see below), plus the leader attendance table.
- **Jitsi room UX** — once the room loads it connects immediately under the
  member's TWIGANE name (`userInfo.displayName`); the prejoin/name-confirmation
  screen is disabled (`prejoinPageEnabled: false`) and there is no intermediate
  "Join video room" button, so a single click on the meeting page puts you in
  the call. A TWIGANE-styled control bar above the iframe mirrors and drives
  the room through the Jitsi IFrame API: mic on/off (`toggleAudio`), camera
  on/off (`toggleVideo`), screen share (`toggleShareScreen`), background
  effects dialog (`toggleVirtualBackgroundDialog`), grid/speaker layout
  (`toggleTileView`), captions (`toggleSubtitles`) and raise hand
  (`toggleRaiseHand`). State is kept truthful via the `audioMuteStatusChanged`,
  `videoMuteStatusChanged`, `screenSharingStatusChanged` and `tileViewChanged`
  events, so the bar stays correct even when a setting is flipped from Jitsi's
  own toolbar. Device selection (choosing which mic/camera to use) remains in
  Jitsi's ⚙ settings menu inside the room — the iframe API has no command for
  it.
- **Google Meet provider** — when scheduling, a leader can pick "Google Meet"
  and paste their own `https://meet.google.com/xxx-xxxx-xxx` link (created at
  meet.google.com or in Google Calendar). The link is strictly validated
  server-side (https + meet.google.com + room-code path only, re-checked by a
  database CHECK), members receive it from the same authorisation-gated join
  endpoint, and opening it records attendance exactly like Jitsi: join on
  click, leave via the button or `sendBeacon` on unload. TWIGANE never embeds
  Meet, so it never needs camera/microphone permission on this path.

## Database

Two migrations (applied on boot when `RUN_MIGRATIONS_ON_BOOT=true`, or via the
migration step of your deployment):

| File | Contents |
| --- | --- |
| `backend/src/db/migrations/015_meetings_enum.sql` | `meeting_status` (`SCHEDULED/LIVE/COMPLETED/CANCELLED`), `meeting_provider` (`JITSI/LIVEKIT/NONE`), `meeting_attendance_status` (`JOINED/LEFT/IN_CALL`) |
| `backend/src/db/migrations/016_group_meetings.sql` | `group_meetings` (unique `provider_room_identifier`, list-view indexes, `MEETING_OVERLAP` trigger preventing overlapping meetings per group) and `meeting_attendance` (partial unique index allows at most one open row per meeting+user) |
| `backend/src/db/migrations/017_google_meet.sql` | Adds `GOOGLE_MEET` to `meeting_provider` and the `join_url` column on `group_meetings` (CHECK-restricted to `https://meet.google.com/...` room-code links) |

## API

All under `/api/meetings`, all behind `requireAuth` + `requireStudent`.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/` | Caller's meetings across all their groups |
| GET | `/history/mine` | Caller's attendance history |
| GET | `/group/:groupId` | Meetings for one authorised group |
| GET | `/:meetingId` | Meeting detail (includes `joinConfig` once joinable) |
| POST | `/` | Schedule a meeting (owner/moderator) |
| PATCH | `/:meetingId` | Edit before it starts (owner/moderator) |
| POST | `/:meetingId/start` | Force-start (owner/moderator) |
| POST | `/:meetingId/complete` | Mark completed (owner/moderator) |
| POST | `/:meetingId/cancel` | Cancel (owner/moderator) |
| POST | `/:meetingId/join` | Authorised join: returns Jitsi room config; auto-starts a SCHEDULED meeting when a leader joins inside the window |
| POST | `/:meetingId/attendance/join` | Record a join (idempotent) |
| POST | `/:meetingId/attendance/leave` | Record a leave (idempotent; `sendBeacon`-safe) |
| GET | `/:meetingId/attendance` | Attendance list (owner/moderator only) |

A periodic sweep (invoked from the service, also safe to run as a cron job)
marks meetings whose end time has passed as `COMPLETED`.

## Environment variables

Set in `backend/.env` (see `backend/.env.example`):

```env
# Bare hostname, no scheme. Default is the public testing server.
JITSI_DOMAIN=meet.jit.si
# Prefix for generated room names, keeps rooms namespaced per deployment.
JITSI_ROOM_PREFIX=twigane
# Which provider the API advertises by default: JITSI | LIVEKIT | NONE
VIDEO_PROVIDER_DEFAULT=JITSI

# Only needed for managed/self-hosted deployments with token auth:
# JITSI_APP_ID=            # JaaS AppID
# JITSI_JWT_SECRET=        # self-hosted token auth; server-side only, never public
# JITSI_JWT_APP_ID=        # self-hosted token auth
```

No new variables are required — the feature works with the existing
`DATABASE_URL` and `AUTH_SECRET`.

## Frontend configuration

`next.config.mjs` sets response headers for `/dashboard/meetings/:path*`:

- **Content-Security-Policy** — adds the configured Jitsi host to
  `frame-src`/`connect-src` so the iframe and its websocket connections load.
- **Permissions-Policy** — `camera=(self), microphone=(self)` so the Jitsi
  iframe may request devices on that page only.

If you change `JITSI_DOMAIN`, update the matching host in
`frontend/next.config.mjs`.

## Local setup

```bash
# 1. Backend — apply migrations (or set RUN_MIGRATIONS_ON_BOOT=true)
cd backend
npm install
npm run db:migrate        # or rely on boot-time migration in development
npm run dev               # API on http://localhost:4000

# 2. Frontend
cd ../frontend
npm install
npm run dev               # http://localhost:3000
```

Then open `/dashboard`, create or join a study group as a student, open
**Meetings**, schedule a meeting inside the join window and click
**Join video room**. The public `meet.jit.si` server works immediately for
testing.

Backend tests (use `DATABASE_URL` or `TEST_DATABASE_URL`; the integration
suites create and use a `<db>_test` database):

```bash
cd backend
DATABASE_URL=postgresql://USER:PASS@localhost:5432/twigane npm test
# meetings only:
node --test tests/meetings.integration.test.js
```

## Production deployment

1. **Do not use `meet.jit.si`.** The public server is rate-limited, offers no
   privacy guarantees and is explicitly not intended for third-party apps.
   Either:
   - **Jitsi-as-a-Service (JaaS)** — set `JITSI_DOMAIN` to your JaaS host and
     configure `JITSI_APP_ID` / `JITSI_JWT_SECRET` so the API mints signed
     JWTs; or
   - **Self-hosted Jitsi** (e.g. the official `jitsi/docker-jitsi-meet`
     compose stack) behind your own HTTPS domain, then set `JITSI_DOMAIN`
     to that hostname. For token-secured deployments set `JITSI_JWT_SECRET`
     and `JITSI_JWT_APP_ID` to match the Jitsi `JWT_*` settings.
2. Set `JITSI_DOMAIN` in `backend/.env` and mirror the host in the frontend
   CSP headers (`frontend/next.config.mjs`).
3. Run migrations as a release step (`RUN_MIGRATIONS_ON_BOOT=false` in
   production).
4. Serve the frontend over HTTPS — browsers only allow camera/microphone
   access in secure contexts.

## Security notes

- **Authorisation is server-side only.** The Jitsi room name is derived from
  the meeting id plus a server-generated prefix; the API only returns
  `joinConfig` to callers who pass the group-membership and time-window checks.
  With self-hosted/JaaS token auth (`JITSI_JWT_SECRET`), knowing the room name
  is not enough to join — a signed token is required.
- **No secrets reach the browser.** `JITSI_JWT_SECRET` (if used) stays
  server-side; integration tests assert the join payload contains no secrets.
- **Attendance can't be forged cross-origin.** Join/leave endpoints are POSTs
  protected by the app's CSRF double-submit scheme and bearer auth;
  `sendBeacon` sends the CSRF credentials the browser already holds.
- **Overlaps and duplicates are enforced in the database** (triggers and
  partial unique indexes), so two concurrent requests cannot double-book or
  open two attendance rows.

## Known limitations

- The public `meet.jit.si` default is for development/testing only (see
  above).
- LiveKit is modelled in the schema (`meeting_provider = 'LIVEKIT'`) and
  study-session video uses `livekit.service.js`, but group meetings currently
  only issue Jitsi config; a LiveKit meeting join path is not implemented yet.
- The lifecycle sweep is invoked opportunistically; for strict status
  accuracy under low traffic, schedule it (cron/`node --eval`) as well.
- Jitsi's own recording/lobby features are not surfaced in the UI; enable and
  govern them on the Jitsi deployment if needed.
