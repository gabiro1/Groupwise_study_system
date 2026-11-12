import { notFound } from "next/navigation";
import LeaderCompatibility from "../../LeaderCompatibility";

const SECTION_KEYS = ["overview", "groups", "members", "sessions", "resources", "requests", "invitations", "matching", "analytics", "settings"];

export function generateStaticParams() {
  return SECTION_KEYS.map((section) => ({ section }));
}

export default async function LeaderSectionPage({ params, searchParams }) {
  const { section } = await params;
  const query = await searchParams;
  if (!SECTION_KEYS.includes(section)) notFound();

  return <LeaderCompatibility section={section} requestedGroupId={typeof query.group === "string" ? query.group : typeof query.groupId === "string" ? query.groupId : ""} />;
}
