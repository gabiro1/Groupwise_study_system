import { redirect } from "next/navigation";

export const metadata = { title: "Dashboard · Lien" };

export default function LecturerPage() {
  redirect("/dashboard");
}
