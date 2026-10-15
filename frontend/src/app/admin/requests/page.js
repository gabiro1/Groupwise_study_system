import RequestsView from "../RequestsView";

export const metadata = {
  title: "Catalogue Requests · Admin · Lien",
  description: "Approve or decline student requests for new courses, skills, and topics.",
};

export default function AdminRequestsPage() {
  return <RequestsView />;
}