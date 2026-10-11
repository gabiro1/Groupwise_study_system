import { ResetPasswordForm } from "../AuthForm";

export const metadata = { title: "Choose a new Lien password" };

export default async function ResetPasswordPage({ searchParams }) {
  const params = await searchParams;
  return <ResetPasswordForm token={typeof params.token === "string" ? params.token : ""} />;
}
