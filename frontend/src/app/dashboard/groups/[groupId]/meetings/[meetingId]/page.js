import { notFound } from "next/navigation";
import GroupPage from "../../../../GroupPage";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export default async function GroupMeetingPage({ params }) {
  const { groupId, meetingId } = await params;
  if (!UUID.test(groupId) || !UUID.test(meetingId)) notFound();
  return <GroupPage groupId={groupId} initialTab="Meetings" meetingId={meetingId} />;
}
