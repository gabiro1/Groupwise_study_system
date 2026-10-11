import AdminShell from "./AdminShell";

export const metadata = {
  title: "Admin · Lien",
  description: "Platform administration and moderation for Lien.",
};

export default function AdminLayout({ children }) {
  return <AdminShell>{children}</AdminShell>;
}
