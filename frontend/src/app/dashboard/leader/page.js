import LeaderCompatibility from "../LeaderCompatibility";

export const metadata = { title: "Group Leader Dashboard · Lien" };

export default async function LeaderPage({ searchParams }) {
  const query = await searchParams;
  return <LeaderCompatibility section={typeof query.section === "string" ? query.section : "overview"} requestedGroupId={typeof query.groupId === "string" ? query.groupId : ""} />;
}
