"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

export function LoginForm({ nextPath }: { nextPath?: string }) {
  const router = useRouter();
  const next =
    nextPath && nextPath.startsWith("/") ? nextPath : "/dashboard";
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  // Network prewarm: when /login mounts, fire-and-forget POST so the
  // server can match our public IP to a registered agent and start the
  // tenant's live-scan session early. By the time the operator finishes
  // typing the password, readers have had ~10 s to warm up. Public
  // endpoint, no auth needed (the IP match IS the auth). On failure or
  // off-network, response is `{prewarmed: false}` and we proceed
  // normally — login flow is unaffected.
  useEffect(() => {
    void fetch("/api/agents/network-prewarm", { method: "POST" }).catch(() => {
      /* swallow — prewarm is best-effort */
    });
  }, []);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setError(data.error ?? "Login failed");
        setPending(false);
        return;
      }
      router.push(next.startsWith("/") ? next : "/dashboard");
    } catch {
      setError("Network error");
      setPending(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="mt-6 flex flex-col gap-4">
      <label className="block">
        <span className="font-mono text-xs text-[var(--muted)]">Email</span>
        <input
          type="email"
          autoComplete="username"
          placeholder="e.g. admin@example.com (local seed)"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="mt-1 w-full rounded-md border border-[var(--surface-border)] bg-[var(--background)] px-3 py-2 text-sm text-[var(--foreground)]"
          required
        />
      </label>
      <label className="block">
        <span className="font-mono text-xs text-[var(--muted)]">Password</span>
        <input
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="mt-1 w-full rounded-md border border-[var(--surface-border)] bg-[var(--background)] px-3 py-2 text-sm text-[var(--foreground)]"
          required
        />
      </label>
      {error ? (
        <p className="font-mono text-xs text-red-400" role="alert">
          {error}
        </p>
      ) : null}
      <button
        type="submit"
        disabled={pending}
        className="rounded-md bg-[var(--accent)] px-4 py-2 font-mono text-sm font-semibold text-[var(--background)] disabled:opacity-50"
      >
        {pending ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}
