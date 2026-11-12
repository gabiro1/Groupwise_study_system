import { GroupCompatibility } from "../CompatibilityRedirect";

export default async function LegacyContainerPage({ searchParams }) {
  const query = await searchParams;
  const groupId = typeof query.groupId === "string" ? query.groupId : "";
  if (!groupId) {
    return (
      <main className="section-page compatibility-page">
        <h1>Choose a study group</h1>
        <p>This old link no longer has a separate dashboard. Open a group to continue.</p>
        <a className="button button-primary" href="/dashboard/groups">Open My Groups</a>
      </main>
    );
  }
  return <GroupCompatibility groupId={groupId} />;
}
