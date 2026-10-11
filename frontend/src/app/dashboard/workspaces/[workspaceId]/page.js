import { notFound } from "next/navigation";
import DashboardWorkspace from "../../DashboardWorkspace";

export default async function WorkspacePage({ params, searchParams }) {
  const { workspaceId } = await params;
  const { tab } = await searchParams;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(workspaceId)) {
    notFound();
  }
  return <DashboardWorkspace section="workspace" workspaceId={workspaceId} workspaceTab={tab} />;
}
