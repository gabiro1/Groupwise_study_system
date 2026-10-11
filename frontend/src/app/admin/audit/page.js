import AuditView from "../AuditView";

export const metadata = {
  title: "Audit log · Admin · Lien",
  description: "Administrative action history.",
};

export default function AdminAuditPage() {
  return <AuditView />;
}
