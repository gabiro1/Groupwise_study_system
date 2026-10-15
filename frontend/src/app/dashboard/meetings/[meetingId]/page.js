import { notFound } from "next/navigation";
import DashboardWorkspace from "../../DashboardWorkspace";

export default async function MeetingDetailPage({ params }) {
  const { meetingId } = await params;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(meetingId)) {
    notFound();
  }
  return <DashboardWorkspace section="meetingDetail" meetingId={meetingId} />;
}
