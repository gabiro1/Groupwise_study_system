import { notFound } from "next/navigation";
import { WorkspaceCompatibility } from "../../CompatibilityRedirect";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export default async function LegacyContainerDetailPage({ params, searchParams }) {
  const { workspaceId } = await params;
  const query = await searchParams;
  if (!UUID.test(workspaceId)) {
    notFound();
  }
  return <WorkspaceCompatibility legacyId={workspaceId} tab={query.tab} />;
}
