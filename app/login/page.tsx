import { Suspense } from "react";
import { redirect } from "next/navigation";
import { DevLocalDbBanner } from "@/components/dev-local-db-banner";
import { getSession } from "@/lib/get-session";
import { LoginForm } from "./login-form";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const session = await getSession();
  const sp = await searchParams;
  if (session) {
    redirect(sp.next?.startsWith("/") ? sp.next : "/dashboard");
  }

  return (
    <div className="flex min-h-full flex-col items-center justify-center px-4 py-6">
      <div className="w-full max-w-lg space-y-4">
        <DevLocalDbBanner />
        <div className="w-full max-w-sm rounded-lg border border-[var(--surface-border)] bg-[var(--surface)] p-8">
        <h1 className="text-lg font-semibold text-[var(--foreground)]">Sign in</h1>
        <p className="mt-1 font-mono text-xs text-[var(--muted)]">
          Sign in with a user that exists in the database behind <code className="text-[var(--accent)]">DATABASE_URL</code> (local seed or production).
        </p>
        <Suspense
          fallback={
            <p className="mt-6 font-mono text-sm text-[var(--muted)]">Loading form…</p>
          }
        >
          <LoginForm nextPath={sp.next} />
        </Suspense>
        </div>
      </div>
    </div>
  );
}
