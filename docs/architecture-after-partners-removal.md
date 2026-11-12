# Twigane architecture after Partners removal

Twigane now follows one student journey:

1. A student maintains an academic and collaboration profile.
2. The recommendation engine analyses that profile against available study groups.
3. Twigane ranks eligible groups and explains the score using real course, topic,
   goal, availability, preference, capacity, privacy, and activity data.
4. The student joins or requests to join a group.
5. Collaboration happens inside the group through discussions, sessions, meetings,
   tasks, resources, notes, progress, and the existing group AI assistant.

## Removed

- The `/dashboard/partners` route and Partners sidebar navigation.
- Partner recommendation tabs, student-to-student request actions, and partner
  profile cards.
- The `/api/partners` route, partner service, direct-message conversation service,
  partner request notifications, and partner-specific validation.
- Dedicated partner connection, direct conversation, and direct message tables via
  migration `032_remove_partners.sql`.

## Preserved shared capabilities

- Student profiles, academic data, privacy controls, authentication, and student
  search remain because group leaders use them to invite classmates.
- The compatibility feature calculations remain because group invitations use the
  two-student compatibility result when ranking invitees.
- Group recommendation scoring, ranking, explanations, feedback, outcome tracking,
  deterministic tie-breaking, and existing group membership workflows remain.
- Group notifications, group discussions, sessions, resources, and the group AI
  assistant remain.

The historical `recommendations.target_student_id` column and `STUDENT` enum value
are retained for audit compatibility with already-applied historical migrations;
active request validation and generation are GROUP-only, and the training export
now filters to group recommendations. No student or group records are deleted.
