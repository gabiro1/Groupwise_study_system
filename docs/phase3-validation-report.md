# Phase 3 — Full-Application Validation, Browser Testing and UAT

**Project:** AI-Based Group Study Linkage App — Mount Kigali University case study
**Validation date:** 2026-11-06
**Scope:** Existing full-stack application only; no new recommendation algorithm or unrelated feature work.

## 1. Executive summary

The engineering validation portion of Phase 3 is complete. The application was inspected, started against the isolated `neondb_test` database, and exercised through a repeatable Playwright browser suite using the actual Next.js frontend and Express API.

Verified results:

| Area | Result |
|---|---|
| Browser end-to-end tests | 5 passed, 0 failed |
| Backend regression | 207 passed, 0 failed, 0 skipped, 0 cancelled |
| Backend lint | Passed |
| Frontend lint | Passed; 0 errors, 6 existing warnings |
| Frontend production build | Passed |
| Migrations | 23 applied, 0 pending, 0 modified |
| Schema cross-check | Passed: 74 tables, 535 SQL statements, 46 enums |
| Real student usefulness evaluation | Not conducted; authorization and participants were not available in this run |

The application is usable for the validated core workflows, including authentication, profile matching inputs, group recommendations, recommendation explanations, student/admin access boundaries, and administrator catalogue/matching pages. The final academic acceptance status is **partially complete** because genuine authorized participant UAT remains pending. No participant feedback or usefulness statistics have been fabricated.

## 2. Application inventory

### Frontend and backend

- Frontend: Next.js 16.3.8, React 19.2.8, Tailwind CSS 4.
- Backend: Express 5.2.1 on Node.js 20+, PostgreSQL through `pg`.
- Frontend API proxy/client: Next.js API routes and the existing frontend API utilities under `frontend/src`.
- Backend entry points: `backend/src/server.js`, `backend/src/config/app.js`, route modules under `backend/src/routes`.
- Test frameworks: Node’s built-in test runner for backend tests and Playwright Test 1.51.1 for browser tests.

### Existing routes and workflow classification

| Feature area | Implemented pages/routes inspected | Classification |
|---|---|---|
| Public/authentication | `/`, `/about`, `/how-it-works`, `/faq`, `/contact`, `/login`, `/register`, `/forgot-password`, `/verify-email`, `/reset-password`, `/resend-verification` | Implemented; email delivery is environment-dependent |
| Student dashboard | `/dashboard`, `/dashboard/[section]` | Implemented |
| Student profile | `/dashboard/profile` | Implemented |
| Group recommendations | `/dashboard/recommendations` | Implemented and browser-tested |
| Group recommendations | `/dashboard/recommendations` | Implemented and browser-tested |
| Group discovery/management | `/dashboard/discover`, `/dashboard/groups`, `/dashboard/workspaces/[workspaceId]`, leader pages | Implemented; only available browser paths were exercised in this run |
| Group collaboration | `/dashboard/groups`, group detail tabs | Implemented in source; not all mutation states were browser-tested |
| Sessions and meetings | `/dashboard/sessions`, `/dashboard/meetings`, `/dashboard/meetings/[meetingId]` | Implemented; API lifecycle and permissions covered by backend tests; external media providers remain configuration-dependent |
| Notifications | `/dashboard/notifications` | Implemented and page navigation browser-tested |
| Administrator console | `/admin`, `/admin/users`, `/admin/academic`, `/admin/matching`, `/admin/groups`, `/admin/sessions`, `/admin/requests`, `/admin/reports`, `/admin/audit`, `/admin/roles`, `/admin/announcements`, `/admin/settings`, `/admin/system`, `/admin/ai`, `/admin/profile` | Implemented; core admin pages browser-tested |
| Optional integrations | LiveKit/Google Meet/email/AI provider | Partially implemented or environment-dependent; not claimed as fully operational without provider-specific browser evidence |
| Real participant usefulness study | Participant recruitment, consent, responses | Pending/not conducted |

## 3. Browser testing environment

The browser environment uses the real local frontend and backend processes, not mocked UI responses.

- Browser runner: Playwright Test 1.51.1.
- Browser: Google Chrome 148.0.7778.169 channel, controlled by Playwright.
- Frontend: `http://127.0.0.1:3000`.
- Backend: `http://127.0.0.1:4000`.
- Database: dedicated `neondb_test` only.
- Test data: deterministic demo accounts and seeded academic/group/session records.
- Browser mode: headless, serial execution (`--workers=1`), screenshots and HTML report retained.
- Secrets: credentials are supplied through environment variables and are not stored in the test source or evidence.

Startup configuration used for validation:

```powershell
$env:DATABASE_URL = '<dedicated test database URL>'
$env:NODE_ENV = 'test'
$env:PORT = '4000'
$env:HOST = '127.0.0.1'
$env:APP_URL = 'http://localhost:3000'
$env:CORS_ORIGINS = 'http://localhost:3000'
$env:RUN_MIGRATIONS_ON_BOOT = 'false'
$env:SEED_DEMO_DATA = 'false'
$env:BACKEND_API_URL = 'http://127.0.0.1:4000'
```

The browser suite is run with account values supplied only at execution time:

```powershell
$env:PHASE3_STUDENT_EMAIL = '<test student>'
$env:PHASE3_STUDENT_PASSWORD = '<test password>'
$env:PHASE3_GROUP_STUDENT_EMAIL = '<test group student>'
$env:PHASE3_GROUP_STUDENT_PASSWORD = '<test password>'
$env:PHASE3_ADMIN_EMAIL = '<test administrator>'
$env:PHASE3_ADMIN_PASSWORD = '<test password>'
npm.cmd run test:e2e -- --workers=1
```

The repository does not contain credentials or the values above.

## 4. Browser automation repair

The previous browser attempt did not establish a working automation session. Repository inspection found no usable Playwright configuration or browser test suite. Playwright Test 1.51.1 was added to the frontend, along with `frontend/playwright.config.js` and `frontend/e2e/phase3.spec.js`.

The Playwright-managed Chromium download did not complete in this environment. An installed Google Chrome executable was available, so the smallest safe repair was to use Playwright’s `channel: "chrome"` option. This produced a repeatable browser run without changing the application runtime.

The initial suite exposed and corrected test-harness issues only: HTML5 password validation, response-listener timing, a seeded-account membership assumption, and an overly broad admin text selector. These were corrected in the test harness; no security validation was weakened.

## 5. Authentication testing

The browser test `registration validation, login, logout, and protected-page redirect` passed.

Verified through the UI:

- Registration page renders.
- Required password confirmation validation is displayed.
- Invalid login displays an alert.
- Valid login reaches the student dashboard.
- Logout returns to the public route.
- A protected profile route redirects to login after logout.

Backend authorization tests additionally cover anonymous rejection, invalid sessions, session revocation, suspended accounts, password/session behavior, and role changes.

Password reset and email-verification screens exist, but delivery-provider behavior was not claimed as fully verified because SMTP/transactional email configuration was not enabled for this run.

## 6. Student workflow testing

The browser suite verifies that a student can:

- Sign in.
- Open profile settings.
- Select courses and learning goals.
- Save the matching profile and observe the success message.
- Navigate to recommendations, discovery, sessions, and notifications.
- Refresh/navigation-load the relevant pages successfully.

The profile test also verifies that profile changes are sent through the frontend workflow and are used by the subsequent recommendation request.

## 7. Group recommendation testing

The browser test `student profile, group recommendations, and backend explanation agreement` passed.

The test captures the actual POST response for `kind: GROUP`, then compares the first backend result with the rendered card:

- Backend result exists and has a score of at least the configured test threshold.
- Backend explanation contains reasons.
- Frontend percentage equals the rounded backend score.
- Frontend displays the backend reason detail.
- The “Why this group?” explanation is visible.
- The group join action is visible.

This directly verifies that the frontend does not independently invent the displayed score or explanation.

## 8. Group recommendation testing

The browser test `group recommendations, eligibility messaging, group discovery, sessions, and notifications` passed.

Verified:

- A group recommendation is returned through the actual API.
- The first result includes a workspace identifier and a valid score.
- The frontend score equals the rounded backend score.
- The group explanation detail is rendered.
- The card shows “Why this group?”.
- An eligible group exposes the “Join group” action.
- The recommended group is visible in group discovery.
- The student can navigate to upcoming sessions and notifications.

Backend tests cover capacity, privacy, archived/inactive groups, membership eligibility, request persistence, and group-workspace eligibility. The browser evidence therefore supports the central eligible-group workflow, while the full matrix of exceptional group states remains primarily API-tested.

## 9. Recommendation usability and understandability

The validated interface uses the plain-language explanation label “Why this group?”. The browser comparison confirms score/explanation agreement with the backend.

Usability strengths observed:

- Recommendations are reachable through the dashboard.
- Scores are displayed as percentages consistently with backend values.
- Explanations are shown beside the recommendation rather than hidden in a separate technical screen.
- The next action is visible on the card.

Limitations to validate with students:

- Whether students interpret a percentage as compatibility rather than a guarantee.
- Whether “complementary strengths” is understood without facilitator explanation.
- Whether incomplete-profile confidence messaging is sufficiently clear.
- Whether the explanation contains enough practical information to motivate a real study interaction.

The application must not present a recommendation as an academic guarantee. UAT should specifically ask participants whether the score and explanation are understandable and appropriately qualified.

## 10. Group management testing

Source inventory and backend integration coverage confirm implemented routes for group creation, discovery, membership requests, invitations, roles, ownership, archival, workspaces, and leader operations. The browser suite verifies group discovery and the eligible join action.

The backend authorization matrix covers owner-only operations, member restrictions, leader role synchronization, archived-group access, pending requests, and group privacy. A complete manual browser pass of every group-management mutation remains a recommended follow-up if a group leader participant is available.

## 11. Study sessions and collaboration

The browser suite verifies that a student can reach the sessions page and that the page renders “Your upcoming sessions”.

The backend integration suite verifies implemented session and meeting behavior, including:

- Session listing and membership visibility.
- Guided-session lifecycle: start, pause, resume, complete.
- Participant roles and rotation.
- Participant-scoped chat, questions, notes, and versioning.
- Meeting scheduling and permissions.
- Join/attendance behavior.
- Overlap rejection.
- Google Meet URL validation.
- LiveKit refusal when provider configuration is absent.

External video-provider operation was not claimed as browser-verified because it requires provider credentials and media permissions.

## 12. Communication and notifications

The browser suite verifies navigation to the notifications page and its heading. Backend tests cover notification creation, group communication authorization, privacy, sessions, and meeting/session notifications.

Unread-count mutation, mark-read interactions, and two-browser message receipt were not claimed as complete browser evidence in this run. They should be included in authorized manual/UAT execution.

## 13. Administrator testing

The browser suite `administrator login, user management, matching, and catalogue pages` passed.

Verified:

- Administrator login reaches `/admin`.
- Dashboard heading renders.
- Users page renders with a search box.
- Matching page exposes the Requests and Generated areas.
- Academic page renders the Course register.

The browser test `student cannot use administrator routes` also passed: a student sees “Admin access required” and does not see the admin dashboard.

Backend tests cover administrator authentication, user management, academic CRUD, role boundaries, session revocation, catalogue request controls, audit behavior, privacy, and last-administrator protection.

## 14. Frontend/backend integration evidence

The browser tests capture real network responses for both recommendation kinds and compare those responses with rendered UI values. This verifies the complete path:

```text
student profile input
  -> frontend API request
  -> Express route and recommendation service
  -> PostgreSQL test database
  -> JSON recommendation result and explanation
  -> rendered frontend card and action
```

The browser run completed 5/5 tests successfully. Backend recommendation integration tests also passed for authorized persistence, terminal outcomes, student recommendations, and group recommendations.

## 15. Security and privacy findings

Verified by browser or backend integration evidence:

- Unauthenticated access is rejected.
- Student access to admin routes is blocked server-side and reflected in the UI.
- Role changes invalidate sessions.
- Suspended/closed resources lose access.
- Private report targets do not disclose private message bodies or equivalent content.
- Self-registration cannot grant privileged roles.
- Last-active-administrator protection passes after deterministic fixture isolation.
- Recommendation privacy filtering and persistence tests pass.

No passwords, tokens, private keys, or real student identities were included in evidence. The only records used were isolated synthetic/demo accounts in `neondb_test`.

## 16. UAT plan and instruments

The formal plan and questionnaires are in [phase3-uat-plan.md](phase3-uat-plan.md). In summary:

- UAT requires Mount Kigali University/institutional authorization before real recruitment or personal-data collection.
- The proposed study is exploratory usability/UAT, not a statistically powered representative study.
- Suggested exploratory sample: 5–8 students, including at least 1–2 potential group leaders, plus 1–2 administrators where available.
- Participants use synthetic or test accounts unless the institution explicitly authorizes real academic data.
- Collect only consent, role, task completion, ratings, comments, and anonymized identifiers.
- Report participant counts and response distributions only after genuine authorized sessions occur.

Actual participant evaluation in this run: **0 participants, 0 responses, pending**.

## 17. Defect report

| ID | Severity | Finding | Root cause | Correction | Regression result |
|---|---|---|---|---|---|
| P3-001 | Medium | Previous browser initialization had no usable repeatable Playwright setup | Missing project runner/config and incomplete browser dependency setup | Added Playwright config, deterministic e2e suite, and Chrome-channel fallback | 5/5 browser tests pass |
| P3-002 | Low | Initial registration test expected custom mismatch validation while browser stopped at native short-password validation | Test fixture password was too short | Used valid-length passwords so the intended mismatch path is reached | Registration test passes |
| P3-003 | Low | Initial group test reused a seeded student already in the target group | Test assumed a clean membership state | Added a separate test account and deterministic profile setup | Group recommendation test passes |
| P3-004 | Medium | Last-admin regression failed when a seeded demo administrator remained an additional active administrator | Test fixture assumed no seeded admin | Test now preserves existing admin states and makes only the target active for that assertion | Targeted test and full 207-test suite pass |
| P3-005 | Environment | First frontend build attempt could not fetch Google Poppins font | Network restriction to fonts.googleapis.com | Retried with permitted network access; no application change required | Production build passes |

No critical or high-severity application defect was found in the executed validation scope.

## 18. Regression testing commands and results

Executed against the dedicated test database:

```powershell
node --test --test-concurrency=1 "tests/**/*.test.js"
```

Result: **207 passed, 0 failed, 0 skipped, 0 cancelled; 56 suites**.

```powershell
npm.cmd run lint                 # backend
npm.cmd run lint                 # frontend
npm.cmd run build                # frontend
npm.cmd run migrate:status      # neondb_test
npm.cmd run check:schema         # neondb_test
npm.cmd run test:e2e -- --workers=1
git diff --check
```

Results: backend lint passed; frontend lint passed with six existing warnings and zero errors; frontend build passed; migration status passed; schema check passed; browser tests passed 5/5; whitespace check passed.

## 19. Thesis evidence generated

- [Browser test specification](../frontend/e2e/phase3.spec.js)
- [Playwright configuration](../frontend/playwright.config.js)
- [Browser HTML report](../frontend/artifacts/phase3/playwright-report/index.html)
- [Student dashboard screenshot](../frontend/artifacts/phase3/student-dashboard.png)
- [Group recommendation screenshot](../frontend/artifacts/phase3/group-recommendation.png)
- [Administrator academic screenshot](../frontend/artifacts/phase3/admin-academic.png)
- [UAT plan and questionnaires](phase3-uat-plan.md)
- This report

## 20. Remaining gaps and blockers

1. Authorized real-student usefulness evaluation has not occurred; no participant results exist yet.
2. Institutional ethics/authorization requirements must be confirmed before recruiting Mount Kigali students or collecting real academic information.
3. A group-leader/admin manual UAT pass should cover every mutation in the group and administration surfaces.
4. Email delivery, LiveKit, Google Meet, and AI-provider behavior require their respective configured environments for end-to-end validation.
5. Notification mark-read mutations and two-user messaging receipt should receive an additional browser/manual pass.

## 21. Phase 3 acceptance assessment

**Engineering/browser validation: complete.**
**Full Phase 3 acceptance: partially complete pending authorized real-participant UAT.**

The application has credible automated backend, integration, and browser evidence. It is not scientifically or academically valid to claim that real students found the recommendations useful until authorized participants complete the prepared UAT protocol.

### Completion plan for the remaining UAT gate

1. Obtain institutional approval and written consent materials.
2. Create isolated synthetic/test accounts or approved anonymized participant accounts.
3. Run the student, group-leader, and administrator scenarios in [phase3-uat-plan.md](phase3-uat-plan.md).
4. Record actual results, comments, screenshots, and defect references without personal identifiers.
5. Recalculate completion and rating summaries from the collected responses.
6. Re-run the browser and regression suites after any correction.
7. Update this report and request review before proceeding to any later phase.
