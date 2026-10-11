import { VerifyEmailForm } from "../AuthForm";

export const metadata = { title: "Verify your Lien account" };

export default async function VerifyEmailPage({ searchParams }) {
  const params = await searchParams;
  return <VerifyEmailForm token={typeof params.token === "string" ? params.token : ""} />;
}
