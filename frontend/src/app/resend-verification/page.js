import Link from "next/link";
import { VerificationResendForm } from "../AuthForm";
import { SiteFooter, SiteHeader } from "../SiteLayout";

export const metadata = { title: "Resend verification email" };

export default async function ResendVerificationPage({ searchParams }) {
  const params = await searchParams;
  const email = typeof params.email === "string" ? params.email : "";

  return (
    <main className="auth-page auth-page-with-site-chrome">
      <SiteHeader />
      <section className="auth-card">
        <div className="auth-heading">
          <span>YOUR STUDY SPACE</span>
          <h1>Resend your verification link.</h1>
          <p>Enter your email address and we’ll send a new link if an unverified account exists.</p>
        </div>
        <VerificationResendForm initialEmail={email} />
        <div className="auth-card-footer">Already verified? <Link href="/login">Sign in</Link></div>
      </section>
      <SiteFooter />
    </main>
  );
}
