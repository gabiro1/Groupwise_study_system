"use client";

import DashboardWorkspace from "./DashboardWorkspace";

export default function GroupPage({ groupId, initialTab = "Overview", meetingId = null }) {
  return <DashboardWorkspace section="group" groupId={groupId} initialGroupTab={initialTab} groupMeetingId={meetingId} />;
}
