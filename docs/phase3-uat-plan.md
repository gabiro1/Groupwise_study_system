# Phase 3 UAT Plan and Evaluation Instruments

This document is a preparation instrument. It does not represent completed participant testing.

## 1. Ethics, consent and privacy gate

Before recruiting Mount Kigali University students or collecting real academic information:

1. Confirm whether university or institutional research approval is required.
2. Obtain written authorization from the responsible supervisor/institution.
3. Provide participants with the purpose, procedure, risks, benefits, voluntary nature, and withdrawal process.
4. Obtain informed consent before the session.
5. Use synthetic/test accounts unless real data is explicitly approved.
6. Do not collect student numbers, passwords, private messages, or unnecessary academic records in the evaluation dataset.
7. Store responses using an anonymous participant code such as `P01`.
8. Do not publish identifiable screenshots or comments.

If approval or participant access is unavailable, conduct only internal testing with synthetic data and report participant UAT as pending.

## 2. Evaluation design

This is exploratory usability and user acceptance testing, not a statistically powered study.

### Proposed participants

- 5–8 students for the central recommendation experience.
- Include at least 1–2 students willing to act as group leaders if approved.
- 1–2 administrators for the console workflows if available.

This sample is practical for a project validation phase but is not statistically representative of the full Mount Kigali student population. Results should be reported as exploratory observations and not generalized prevalence estimates.

### Procedure

1. Explain the study and obtain consent.
2. Give the participant a synthetic account and a short scenario.
3. Ask the participant to think aloud only if that does not interfere with task completion.
4. Do not coach the participant toward a positive answer.
5. Record completion, errors, time/notes where appropriate, and participant comments.
6. Administer the neutral questionnaire after the tasks.
7. Ask the participant not to enter real passwords or private academic information.

## 3. Student and group-leader UAT cases

| Test ID | Role | Objective | Preconditions | Test steps | Expected result | Actual result | Status | Feedback |
|---|---|---|---|---|---|---|---|---|
| UAT-ST-01 | Student | Register and sign in | Approved test account or new synthetic email | Open registration, complete fields, submit, sign in | Registration validation is understandable and login reaches dashboard | Pending | Pending | Pending |
| UAT-ST-02 | Student | Complete matching profile | Signed in | Add courses, strengths, learning needs, goals, preferences and availability; save; refresh | Values save and remain visible after refresh | Pending | Pending | Pending |
| UAT-ST-03 | Student | Find partner recommendations | Completed matching profile | Open recommendations and request partner results | Results appear in understandable ranked cards | Pending | Pending | Pending |
| UAT-ST-04 | Student | Understand partner explanation | Partner result available | Open details and explain why the first partner was shown | Participant can describe score, reasons, and limitations in their own words | Pending | Pending | Pending |
| UAT-ST-05 | Student | Assess partner relevance | Partner result available | Compare course, strengths/needs, goals and availability with own expectations | Participant can identify whether the result seems academically relevant | Pending | Pending | Pending |
| UAT-ST-06 | Student | Find group recommendations | Completed matching profile and available group fixture | Open group recommendations and group details | Eligible groups are shown with capacity, visibility and join state | Pending | Pending | Pending |
| UAT-ST-07 | Student | Request/join a group | Eligible group with request policy | Select join/request action and observe result | Request is recorded and UI state changes without falsely implying membership | Pending | Pending | Pending |
| UAT-ST-08 | Student | Use discovery and sessions | At least one seeded group/session | Browse discovery, sessions and notifications | Pages are findable and status/permissions are understandable | Pending | Pending | Pending |
| UAT-ST-09 | Student | Verify privacy boundary | Student account | Attempt admin URL and private conversation not owned by participant | Access is denied without private data leakage | Pending | Pending | Pending |
| UAT-GL-01 | Group leader | Create/manage a group | Approved leader account | Create/edit group and inspect member controls | Leader can perform authorized actions and sees clear role boundaries | Pending | Pending | Pending |
| UAT-GL-02 | Group leader | Process membership | Pending request fixture | Accept/reject request and inspect notification/state | Request and membership state update consistently | Pending | Pending | Pending |
| UAT-GL-03 | Group leader | Schedule a session | Active group | Create/edit/cancel session; inspect participants | Session status and permissions remain consistent | Pending | Pending | Pending |

## 4. Administrator UAT cases

| Test ID | Role | Objective | Preconditions | Test steps | Expected result | Actual result | Status | Feedback |
|---|---|---|---|---|---|---|---|---|
| UAT-AD-01 | Administrator | Sign in and access console | Approved admin account | Sign in and open dashboard | Admin dashboard loads; student account cannot reach it | Pending | Pending | Pending |
| UAT-AD-02 | Administrator | Manage users | Admin account and test users | Search, filter, open user, change allowed status/role | Changes persist and are audited; forbidden role actions are rejected | Pending | Pending | Pending |
| UAT-AD-03 | Administrator | Manage academic catalogue | Admin account | Open academic page, inspect/edit a synthetic course, archive if approved | Catalogue changes are validated and reflected in student forms | Pending | Pending | Pending |
| UAT-AD-04 | Administrator | Configure matching | Admin account | Open matching, view weights, submit valid and invalid configurations | Valid configuration persists; invalid configuration shows an error and does not claim success | Pending | Pending | Pending |
| UAT-AD-05 | Administrator | Review analytics/outcomes | Seeded recommendation outcomes | Open analytics/reporting pages | Counts and empty states are understandable and do not expose private messages | Pending | Pending | Pending |
| UAT-AD-06 | Administrator | Verify role/security boundaries | Admin plus student account | Attempt protected URLs using student session | Student remains blocked; admin actions require server authorization | Pending | Pending | Pending |

## 5. Student questionnaire

Use a five-point scale for statements: **1 Strongly disagree, 2 Disagree, 3 Neither agree nor disagree, 4 Agree, 5 Strongly agree**, plus `Not applicable` where needed.

### Ease of use

1. Registration and profile completion were understandable.
2. It was easy to find the recommendation feature.
3. The recommendation interface was easy to navigate.
4. The next action after viewing a recommendation was clear.

### Recommendation understanding

5. I understood why the recommended student was shown to me.
6. I understood what the compatibility score represented.
7. I understood why the recommended group was shown to me.
8. The explanation used language I could understand.
9. The application made clear that a recommendation is a suggestion, not a guarantee.

### Recommendation relevance

10. The recommended student appeared relevant to my declared courses.
11. The recommended student appeared relevant to my learning goals.
12. The recommended group appeared relevant to my learning goals.
13. The recommendations reflected my declared availability.
14. Complementary strengths or learning needs were useful in judging the recommendation.

### Perceived usefulness

15. I would consider studying with a recommended student.
16. I would consider requesting or joining a recommended group.
17. The application helped me identify potentially useful study partners.
18. I would use this feature again for another course or learning goal.

### Open questions

19. What was the most useful part of the recommendation experience?
20. What was confusing or difficult?
21. Did any recommendation feel irrelevant? Please explain without naming another student.
22. What would you improve first?
23. Is there anything about privacy or sharing information that concerned you?

## 6. Administrator checklist/questionnaire

Record `Pass`, `Fail`, or `Not applicable`, followed by a comment:

- Login and role restrictions were clear.
- User search and details were usable.
- Catalogue changes showed understandable validation.
- Matching weight changes showed a clear success or failure state.
- Analytics and recommendation outcomes were understandable.
- Audit/security information was sufficient for administrative decisions.
- The console did not expose private student conversations unnecessarily.
- Most important improvement:

## 7. Data collection and analysis

For each participant, retain only:

- Anonymous participant code.
- Role.
- Scenario/test ID.
- Pass/fail/blocked status.
- Optional task notes.
- Questionnaire ratings.
- Non-identifying comments.

Report:

- Number invited, number consented, number completing each task.
- Completed, failed and blocked test cases.
- Rating counts and distributions for each statement.
- Median or mean only when the small sample is clearly labelled exploratory.
- Common positive themes, confusion points, privacy concerns, and suggested improvements.

Do not report invented values. Before participants complete testing, all result fields in this plan remain `Pending`.
