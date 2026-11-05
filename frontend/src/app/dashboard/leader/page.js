import LeaderDashboard from "./LeaderDashboard";

export const metadata = { title: "Group Leader Dashboard · Lien" };

export default async function LeaderPage({ searchParams }) {
  const query = await searchParams;
  const initialSection = typeof query.section === "string" ? query.section : "overview";
  const initialGroupId = typeof query.groupId === "string" ? query.groupId : null;
  return <LeaderDashboard initialSection={initialSection} initialGroupId={initialGroupId} />;
}
