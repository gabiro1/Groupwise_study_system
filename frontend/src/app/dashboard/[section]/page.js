import { notFound } from "next/navigation";
import DashboardWorkspace from "../DashboardWorkspace";

const sections = ["discover", "groups", "meetings", "sessions", "courses", "recommendations", "profile", "notifications"];

export function generateStaticParams() {
  return sections.map((section) => ({ section }));
}

export default async function DashboardSectionPage({ params }) {
  const { section } = await params;
  if (!sections.includes(section)) notFound();

  return <DashboardWorkspace section={section} />;
}
