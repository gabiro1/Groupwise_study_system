import { notFound } from "next/navigation";
import LeaderDashboard from "../LeaderDashboard";
import { SECTION_KEYS } from "../sections";

export function generateStaticParams() {
  return SECTION_KEYS.map((section) => ({ section }));
}

export default async function LeaderSectionPage({ params, searchParams }) {
  const { section } = await params;
  const query = await searchParams;
  if (!SECTION_KEYS.includes(section)) notFound();

  return <LeaderDashboard initialSection={section} initialGroupId={query.group} />;
}
