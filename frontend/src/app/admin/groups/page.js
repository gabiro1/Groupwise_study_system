import { Suspense } from "react";
import GroupsView from "../GroupsView";
import { Skeleton } from "../DataState";

export const metadata = {
  title: "Study groups · Admin · Lien",
  description: "Monitor study groups.",
};

export default function AdminGroupsPage() {
  return (
    <Suspense fallback={<Skeleton rows={6} />}>
      <GroupsView />
    </Suspense>
  );
}
