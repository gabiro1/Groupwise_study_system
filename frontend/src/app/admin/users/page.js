import { Suspense } from "react";
import UsersView from "../UsersView";
import { Skeleton } from "../DataState";

export const metadata = {
  title: "Users · Admin · Lien",
  description: "Manage platform accounts.",
};

export default function AdminUsersPage() {
  return (
    <Suspense fallback={<Skeleton rows={6} />}>
      <UsersView />
    </Suspense>
  );
}
