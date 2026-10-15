import DashboardWorkspace from "../DashboardWorkspace";
import MeetingsSection from "../meetings/MeetingsSection";

export default function MeetingsPage() {
  return <DashboardWorkspace section="meetings" />;
}

export function MeetingsContent({ leadGroups }) {
  return <MeetingsSection leadGroups={leadGroups} />;
}
