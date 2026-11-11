# Implementation and Thesis Gap Todo

## Status legend

- [x] Complete: implemented in the current codebase and supported by a clear frontend, backend, schema, or test path.
- [~] Partial: implemented in part, implemented differently from the thesis, or awaiting stronger evidence.
- [ ] Not yet done: no complete implementation or evidence was found.
- [!] Blocked: the code may exist, but verification is blocked by the environment or missing project evidence.

## 1. Thesis requirements and core system features

### Authentication and accounts

- [x] Student registration.
- [x] Login and logout.
- [x] Access and refresh session handling.
- [x] Email verification flow.
- [x] Password reset flow.
- [x] Password hashing.
- [x] Session revocation after sensitive account changes.
- [x] Suspended-account protection.
- [x] Role separation for students, group leaders, and administrators.
- [x] Protection against public registration granting privileged roles.
- [~] Full runtime verification of all authentication flows.
  - [ ] Configure the dedicated integration test database.
  - [ ] Run the complete authentication integration suite against that database.
  - [ ] Perform browser tests for registration, verification, login, logout, and password reset.

### Student profile and academic information

- [x] Student profile creation and editing.
- [x] First name and last name.
- [x] Academic university, programme, and course information.
- [x] Academic level and profile onboarding state.
- [x] Learning goals.
- [x] Preferred study format.
- [x] Preferred study style.
- [x] Preferred group-size range.
- [x] Preferred study-session duration.
- [x] Weekly study goal.
- [x] Free-text partner preferences.
- [x] Weekly availability slots.
- [x] Topic strengths and self-ratings.
- [x] Skills a student can teach or wants to develop.
- [x] Profile privacy controls.
- [x] Availability visibility control.
- [x] Skill and topic visibility controls.
- [x] Personalised-recommendation preference control.
- [~] Evidence that students understand and complete the profile fields.
  - [ ] Conduct user acceptance testing with representative students.
  - [ ] Record profile-completion problems and revise onboarding copy where needed.

### Recommendation and matching system

- [x] Recommendations for study partners.
- [x] Recommendations for study groups.
- [x] Course compatibility scoring.
- [x] Skill complementarity scoring.
- [x] Topic similarity scoring.
- [x] Learning-goal compatibility scoring.
- [x] Availability overlap scoring.
- [x] Study-preference compatibility scoring.
- [x] Group-size compatibility scoring.
- [x] Activity and dormancy considerations for groups.
- [x] Data-confidence adjustment for incomplete profiles.
- [x] Minimum-score filtering.
- [x] Ranked recommendation results.
- [x] Human-readable recommendation reasons.
- [x] Recommendation warnings for weak or incomplete data.
- [x] Stored recommendation requests and results.
- [x] Recommendation history.
- [x] Accept, reject, click, and shown outcome tracking.
- [x] Qualitative recommendation feedback.
- [x] Recommendation detail and explanation endpoint.
- [x] Admin-adjustable recommendation weights.
- [x] Versioned recommendation model configuration.
- [~] Recommendation usefulness has not been proven with real users.
  - [ ] Define success measures such as acceptance rate, response rate, and precision@K.
  - [ ] Run a controlled user evaluation with Mount Kigali University students.
  - [ ] Compare recommendations based on similarity against recommendations based on complementarity.
  - [ ] Record the results for the thesis evaluation chapter.

### AI requirement from the thesis

- [~] Optional AI natural-language matching/search exists.
- [~] AI provider abstraction and failover support exists.
- [~] AI configuration and health screens exist in the admin area.
- [ ] A trained machine-learning model has not been implemented.
- [ ] Learned parameters have not been implemented.
- [ ] A Python matching backend has not been implemented.
- [ ] A training dataset has not been documented.
- [ ] Model training, validation, and test metrics have not been documented.
- [ ] AI matching accuracy has not been measured.
- [ ] AI provider configuration has not been proven in the current environment.

Required decision:

- [x] Revise the thesis-facing explanation to describe a hybrid grounded AI assistant and a deterministic weighted recommendation system; the assistant is not retrained for every student.
- [ ] Or implement and evaluate a real trained AI/machine-learning matching model.
- [ ] If the AI provider remains optional, document the fallback behaviour clearly.
- [ ] Document the AI provider, model, prompt/input constraints, privacy handling, and failure behaviour.

### Study groups

- [x] Browse and search study groups.
- [x] Create a study group.
- [x] Edit a study group.
- [x] Join an open group.
- [x] Request to join a restricted group.
- [x] Leave a group.
- [x] Invite members.
- [x] Accept or decline invitations.
- [x] Approve or reject join requests.
- [x] Assign group roles.
- [x] Remove group members.
- [x] Transfer group ownership.
- [x] Change group privacy.
- [x] Archive a group.
- [x] Group moderation queue.
- [x] Group announcements.
- [x] Group analytics.
- [x] Recommended members for group leaders.
- [x] Workspace creation and access for groups.
- [~] Full group lifecycle verification against the database.
  - [ ] Run group creation, joining, moderation, ownership transfer, and archive tests on the dedicated test database.
  - [ ] Test group access after suspension and archive operations.

### Study sessions and collaboration

- [x] Create and schedule study sessions.
- [x] Session listing and detail views.
- [x] Session RSVP handling.
- [x] Session lifecycle transitions.
- [x] Session participant permissions.
- [x] Session role rotation.
- [x] Manual role assignment.
- [x] Session agenda.
- [x] Session timer.
- [x] Timer pause, resume, advance, and extension.
- [x] Session chat.
- [x] Question queue.
- [x] Question answers and status changes.
- [x] Shared notes.
- [x] Note editing and deletion.
- [x] Participant preparation status.
- [x] Session reflections.
- [x] Session summary.
- [x] Optional LiveKit session-token path.
- [~] Full runtime verification is incomplete because some integration suites timed out.
  - [ ] Rerun session integration tests using a reliable test database.
  - [ ] Verify participant privacy and permission boundaries in a browser.

### Partner communication and notifications

- [x] Study-partner invitations.
- [x] Accept, decline, and withdraw partner invitations.
- [x] Private partner conversations.
- [x] Direct messages.
- [x] Workspace messages.
- [x] Notifications inbox.
- [x] Notification preferences.
- [x] Unread notification counts.
- [x] Mark-all-as-read behaviour.
- [~] End-to-end delivery and notification timing are not fully verified.
  - [ ] Test unread counts across login sessions and multiple browser tabs.
  - [ ] Test notification delivery for group, session, invitation, and moderation events.

## 2. Features beyond the original thesis scope

### Video meetings

- [x] Jitsi meeting support.
- [x] Google Meet link support.
- [~] LiveKit support is implemented as an optional configuration path.
- [~] Video meetings conflict with the thesis statement that video calls are excluded.
- [ ] Decide whether video meetings are part of the final thesis scope.
- [ ] If retained, update the scope, tools, requirements, screenshots, testing, and limitations chapters.
- [ ] If excluded, clearly label the feature as a later extension rather than a thesis requirement.

### AI assistant and conversations

- [x] AI conversation data model exists.
- [x] AI provider registry exists.
- [x] Provider failover and circuit-breaker support exists.
- [x] AI admin configuration screens exist.
- [~] AI functionality depends on external provider configuration.
- [ ] Test the system with a real configured provider.
- [ ] Document provider cost, rate limits, privacy, and failure handling.

## 3. Administration checklist

### Admin access and navigation

- [x] Admin shell and navigation.
- [x] Admin-only frontend guard.
- [x] Backend authentication and administrator authorization.
- [x] Admin profile page.
- [x] Admin logout.
- [x] Admin system-status indicator.
- [~] Runtime admin access verification is blocked by the test database configuration.

### User administration

- [x] List users.
- [x] Search users.
- [x] Filter users by role, status, university, and course.
- [x] Paginate user lists.
- [x] View user details.
- [x] View role history.
- [x] Update user information.
- [x] Suspend a user.
- [x] Restore a user.
- [x] Change a user role.
- [x] Revoke affected sessions after role changes.
- [x] Prevent self-suspension.
- [x] Prevent administrator self-escalation.
- [x] Prevent changing another administrator through the normal role endpoint.
- [ ] Complete runtime CRUD testing against the dedicated test database.

### Academic administration

- [x] View academic catalogue information.
- [x] Search courses.
- [x] Create courses.
- [x] Edit courses.
- [x] Archive courses.
- [x] Validate course data.
- [x] Reject duplicate course codes.
- [x] Catalogue request queue.
- [x] Approve catalogue requests.
- [x] Decline catalogue requests with an administrative note.
- [ ] Complete the admin academic integration tests; they are currently blocked by the missing `neondb_test` database.

### Group and session administration

- [x] View study groups.
- [x] Search and filter study groups.
- [x] View group details.
- [x] Suspend a group.
- [x] Restore a suspended group.
- [x] Archive a group.
- [x] Remove a group member.
- [x] View workspaces.
- [x] View workspace detail and aggregate activity.
- [x] View study sessions.
- [x] View session statistics.
- [x] View meetings.
- [x] View meeting statistics.
- [x] Cancel a study session.
- [ ] Perform runtime verification of each administrative mutation.

### Moderation and reporting

- [x] View reports.
- [x] View report details.
- [x] Filter reports.
- [x] Resolve reports.
- [x] Dismiss reports.
- [x] Apply target-bound moderation actions.
- [x] Prevent moderation actions against administrators.
- [x] Prevent private-target disclosure.
- [x] Record moderation actions in the audit trail.
- [ ] Complete full report-resolution testing on a seeded database.

### Announcements and notifications

- [x] List announcements.
- [x] View announcement details.
- [x] Create announcements.
- [x] Edit announcements.
- [x] Publish announcements.
- [x] Archive announcements.
- [x] Delete announcements.
- [x] Broadcast platform notifications.
- [ ] Verify recipient targeting and delivery with real notification records.

### Settings, analytics, AI, and audit

- [x] View system settings.
- [x] Update system settings.
- [x] Delete supported settings.
- [x] View settings sections.
- [x] View platform analytics.
- [x] Export analytics.
- [x] View matching performance.
- [x] View AI configuration.
- [x] View AI usage.
- [x] Test the AI provider path.
- [x] Reset AI provider circuit state.
- [x] Search audit logs.
- [x] View system health.
- [~] Runtime verification is incomplete for all settings, analytics export, AI, and system-health paths.

## 4. Security and privacy checklist

- [x] Passwords are hashed.
- [x] Protected routes require authentication.
- [x] Administrative routes require administrator role.
- [x] Student and group-leader accounts cannot access admin routes.
- [x] CSRF protection exists for mutating requests.
- [x] Rate limits exist for authentication, search, AI, and writes.
- [x] Input validation exists for API requests.
- [x] SQL queries use bound parameters.
- [x] Sensitive audit metadata is sanitized.
- [x] Audit logs are used for administrative mutations.
- [x] Private report targets are protected from existence probing.
- [x] Session revocation is applied after suspension and role changes.
- [~] Security tests cannot all be considered final until the dedicated integration database is available.
- [ ] Conduct a formal privacy review for student profile visibility and recommendation data.
- [ ] Document retention, deletion, export, and consent procedures.
- [ ] Document the university approval and ethical-review evidence required by the thesis.

## 5. Testing and quality assurance

- [x] Unit tests for scoring and matching functions.
- [x] Validation tests.
- [x] Security-hardening tests.
- [x] Authorization tests are written.
- [x] Academic-admin integration tests are written.
- [x] Session integration tests are written.
- [x] Meeting integration tests are written.
- [x] Backend syntax/lint checks pass.
- [x] Database schema cross-check passes.
- [x] Frontend production build passes.
- [!] Full integration suite is not currently repeatable because the derived `neondb_test` database does not exist and remote database connections timed out.
- [ ] Create a dedicated seeded test database.
- [ ] Set `TEST_DATABASE_URL` explicitly.
- [ ] Run migrations against the test database.
- [ ] Seed required roles, courses, goals, topics, and reference data.
- [ ] Run all backend tests to completion.
- [ ] Add frontend component tests for the main admin and student flows.
- [ ] Add Playwright end-to-end tests.
- [ ] Add tests for responsive admin navigation.
- [ ] Add browser tests for invalid inputs, authorization failures, and expired sessions.
- [ ] Complete formal user acceptance testing.
- [ ] Record test evidence, screenshots, test data, pass rates, and known defects for Chapter 6.

## 6. Deployment and operations

- [~] Local production frontend build works.
- [~] Backend starts structurally, subject to valid runtime environment configuration.
- [ ] Provide a documented deployment environment.
- [ ] Document production environment variables without exposing secrets.
- [ ] Configure production database migrations as a release step.
- [ ] Configure backups and recovery testing.
- [ ] Configure application monitoring and alerting.
- [ ] Configure upload storage and retention.
- [ ] Configure email delivery and verify verification/reset emails.
- [ ] Configure an AI provider if AI search is required.
- [ ] Configure the chosen video provider for production.
- [ ] Perform a live smoke test after deployment.
- [ ] Record deployment URL, date, version, database version, and rollback procedure.
- [ ] Record maintenance feedback and resolved issues.

## 7. Thesis alignment work

- [ ] Add a complete system-requirements table mapping every thesis requirement to a screen, API route, and database entity.
- [ ] Add use-case, context, data-flow, activity, and entity-relationship diagrams.
- [ ] Ensure diagrams match the current database and route names.
- [ ] Update the architecture description from Python to Node.js/Express if the current implementation remains unchanged.
- [ ] Explain the weighted matching formula and every weight.
- [ ] Explain complementarity between strengths and weaknesses.
- [ ] Explain how incomplete profile data affects recommendation confidence.
- [ ] Document group recommendations separately from partner recommendations.
- [ ] Document recommendation acceptance, rejection, and feedback tracking.
- [ ] Add database schema screenshots or diagrams.
- [ ] Add student-facing interface screenshots.
- [ ] Add administrator interface screenshots.
- [ ] Add security and authorization test results.
- [ ] Add performance observations for recommendation generation and database queries.
- [ ] Add user acceptance results from Mount Kigali University students.
- [ ] Add limitations based on measured evidence rather than planned limitations only.
- [ ] Decide whether video calls are in scope or a post-thesis extension.
- [ ] Decide whether AI is an optional assistant or the actual matching method.
- [ ] Add a final comparison between planned features and delivered features.
- [ ] Add a final list of unfinished work and future recommendations.

## 8. Priority order

### Priority 1: required before claiming completion

- [ ] Create and seed the dedicated test database.
- [ ] Run the admin academic CRUD and authorization suites successfully.
- [ ] Run the complete backend integration suite successfully.
- [ ] Add browser-level tests for the main student and administrator workflows.
- [ ] Conduct and document user acceptance testing.
- [ ] Resolve the thesis wording mismatch about AI, Python, and the matching algorithm.

### Priority 2: required for a strong final thesis

- [ ] Produce system analysis and design diagrams that match the current code.
- [ ] Document recommendation evaluation metrics.
- [ ] Document deployment and maintenance evidence.
- [ ] Add interface screenshots and test evidence.
- [ ] Document privacy, consent, retention, and university approval procedures.

### Priority 3: future improvements

- [ ] Add a mobile application.
- [ ] Add university student-record integration.
- [ ] Add a trained or learned matching model if the AI claim must be retained.
- [ ] Add longitudinal evaluation of whether recommendations improve study outcomes.
- [ ] Add richer administrative export and reporting if required by university staff.

## Final status

- Core application concept: [x] implemented.
- Core student matching workflow: [x] implemented.
- Group and session collaboration: [x] implemented.
- Administrator functionality: [x] implemented in code, [!] not fully runtime-verified.
- Security controls: [x] implemented in code, [!] final integration verification pending.
- AI matching claim: [~] only partially aligned with the thesis.
- Testing evidence: [~] substantial automated coverage exists, but full execution and UAT are incomplete.
- Deployment evidence: [ ] not yet complete.
- Thesis alignment: [~] requires revision before final submission.
