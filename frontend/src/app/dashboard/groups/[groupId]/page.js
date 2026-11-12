import { notFound } from "next/navigation";
import GroupPage from "../../GroupPage";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export default async function GroupRoute({ params, searchParams }) {
  const { groupId } = await params;
  const query = await searchParams;
  if (!UUID.test(groupId)) notFound();
  return <GroupPage groupId={groupId} initialTab={typeof query.tab === "string" ? query.tab : "Overview"} />;
}
