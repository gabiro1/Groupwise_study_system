import { LoginForm } from "../AuthForm";

export const metadata = { title: "Sign in to Lien" };

export default async function LoginPage({ searchParams }) {
  const params = await searchParams;
  return <LoginForm nextPath={typeof params.next === "string" ? params.next : "/dashboard"} />;
}
