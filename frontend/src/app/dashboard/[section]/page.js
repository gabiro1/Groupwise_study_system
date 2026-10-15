import { notFound } from "next/navigation";
import DashboardWorkspace from "../DashboardWorkspace";

const sections = ["discover", "groups", "workspaces", "messages", "meetings", "partners", "sessions", "courses", "recommendations", "profile", "notifications"];

export function generateStaticParams() {
  return sections.map((section) => ({ section }));
}

export default async function DashboardSectionPage({ params, searchParams }) {
  const { section } = await params;
  const query = await searchParams;
  if (!sections.includes(section)) notFound();

  return <DashboardWorkspace section={section} workspaceGroupId={query.groupId} initialConversationId={query.with} />;
}
