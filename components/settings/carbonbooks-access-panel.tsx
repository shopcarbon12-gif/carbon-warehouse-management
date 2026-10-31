"use client";

import { useState } from "react";
import useSWR from "swr";
import type { TenantUserListRow } from "@/lib/queries/settings-users";

/**
 * CARBONBOOKS section of Settings → Users & roles.
 *
 * Who may see CarbonBooks and at which level is decided here, but stored and enforced by
 * CarbonBooks itself (books.shopcarbon.com): WMS only forwards the change. Every change needs
 * the acting CarbonBooks Admin's SMS code. Everyone starts Blocked — CarbonBooks is invisible
 * to them, including in the WMS menu.
 */
const LEVELS = [
  { id: "blocked", label: "Blocked", help: "Doesn't see CarbonBooks at all." },
  { id: "read", label: "Read", help: "Can look and export, can't change anything." },
  { id: "write", label: "Write", help: "Can prepare drafts: bills, expenses, invoices, bank sorting." },
  { id: "approve", label: "Approve", help: "Can post, pay, reconcile, close months, approve returns." },
  { id: "admin", label: "Admin", help: "Everything, plus who has access." },
] as const;
type Level = (typeof LEVELS)[number]["id"];
const AREAS = [
  ["overview", "Overview"], ["sales", "Sales & Channels"], ["banking", "Banking"], ["expenses", "Expenses & Bills"],
  ["invoices", "Invoices"], ["inventory", "Inventory & COGS"], ["taxes", "Taxes"], ["team", "Team"],
  ["payroll", "Payroll"], ["reports", "Reports"], ["journal", "Journal"], ["settings", "Settings"],
] as const;

type Grant = { level: Level; areaOverrides: Partial<Record<string, Level>>; companyIds: string[] | null; locationIds: string[] | null };
type AccessInfo = { grant: Grant; account: { status: string; username: string | null; phoneHint: string | null } | null; isSelf: boolean };

const fetcher = async (url: string) => {
  const res = await fetch(url, { cache: "no-store" });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error((j as { error?: string }).error ?? res.statusText), { status: res.status });
  return j;
};
const fullName = (u: TenantUserListRow) => [u.first_name, u.last_name].filter(Boolean).join(" ") || u.email;

const inputCls = "w-full rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface)] px-3 py-2.5 text-base text-[var(--wms-fg)] min-h-[48px]";
const btnCls = "min-h-[48px] rounded-md px-5 py-2.5 font-semibold disabled:opacity-50";
const primaryCls = `${btnCls} bg-[var(--wms-accent)] text-[var(--wms-on-accent,#000)]`;
const secondaryCls = `${btnCls} border border-[var(--wms-border)] text-[var(--wms-fg)]`;

export function CarbonBooksAccessPanel() {
  const { data: users } = useSWR<TenantUserListRow[]>("/api/settings/access/users", fetcher, { revalidateOnFocus: false });
  const [userId, setUserId] = useState("");
  const user = users?.find((u) => u.id === userId);
  return (
    <div className="space-y-4">
      <p className="text-sm text-[var(--wms-muted)]">
        Choose who can open CarbonBooks and what they may do. People set to <b>Blocked</b> don&rsquo;t see CarbonBooks anywhere, including this menu.
        Every change is confirmed with a code texted to <b>your</b> phone and recorded in the CarbonBooks security log.
      </p>
      <label className="block space-y-1.5">
        <span className="text-sm font-semibold">Person</span>
        <select className={inputCls} value={userId} onChange={(e) => setUserId(e.target.value)}>
          <option value="">Choose a person…</option>
          {(users ?? []).map((u) => <option key={u.id} value={u.id}>{fullName(u)} — {u.email}</option>)}
        </select>
      </label>
      {user ? <PersonAccess key={user.id} user={user} /> : null}
    </div>
  );
}

function PersonAccess({ user }: { user: TenantUserListRow }) {
  const { data, error, mutate } = useSWR<AccessInfo>(`/api/carbonbooks/access?user=${user.id}`, fetcher, { revalidateOnFocus: false });
  const [level, setLevel] = useState<Level | null>(null);
  const [overrides, setOverrides] = useState<Partial<Record<string, Level>> | null>(null);
  const [phone, setPhone] = useState("");
  const [step, setStep] = useState<"edit" | "code" | "done">("edit");
  const [challenge, setChallenge] = useState("");
  const [hint, setHint] = useState("");
  const [code, setCode] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [invite, setInvite] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (error) {
    const status = (error as { status?: number }).status;
    return <Notice ok={false} text={status === 403 ? "Only CarbonBooks Admins can manage CarbonBooks access." : error.message} />;
  }
  if (!data) return <p className="text-sm text-[var(--wms-muted)]">Loading…</p>;

  const curLevel = level ?? data.grant.level;
  const curOver = overrides ?? data.grant.areaOverrides ?? {};
  const needsInvite = curLevel !== "blocked" && (!data.account || data.account.status !== "active");

  async function askCode() {
    setBusy(true); setMsg(null);
    const r = await fetch("/api/carbonbooks/access/confirm", { method: "POST" });
    const j = await r.json().catch(() => ({}));
    setBusy(false);
    if (!r.ok) return setMsg({ ok: false, text: j.error ?? "Couldn't send the code." });
    setChallenge(j.challenge); setHint(j.phoneHint); setCode(""); setStep("code");
  }
  async function apply() {
    setBusy(true); setMsg(null);
    const r = await fetch("/api/carbonbooks/access", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        target: user.id,
        grant: { level: curLevel, areaOverrides: curOver, companyIds: data!.grant.companyIds, locationIds: data!.grant.locationIds },
        invitePhone: needsInvite && phone ? phone.trim() : undefined,
        challenge, code,
      }),
    });
    const j = await r.json().catch(() => ({}));
    setBusy(false);
    if (!r.ok) {
      if (j.field !== "code") setStep("edit");
      return setMsg({ ok: false, text: j.error ?? "The change wasn't saved." });
    }
    setInvite(j.inviteUrl ?? null); setStep("done"); setMsg({ ok: true, text: "Saved. The change is in the CarbonBooks security log." });
    setLevel(null); setOverrides(null); setPhone("");
    await mutate();
  }

  if (data.isSelf) return <Notice ok={false} text="You can't change your own CarbonBooks access — another CarbonBooks Admin must do it." />;

  return (
    <div className="space-y-4 rounded-lg border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] p-4">
      <div className="text-sm">
        <b>CarbonBooks account:</b>{" "}
        {data.account?.status === "active" ? <>active — username <code>{data.account.username}</code>, phone {data.account.phoneHint}</>
          : data.account?.status === "invited" ? <>invitation sent (phone {data.account.phoneHint}), not accepted yet</>
          : <>none yet</>}
      </div>

      {step !== "code" && (
        <>
          <fieldset className="space-y-2">
            <legend className="text-sm font-semibold">Access level</legend>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {LEVELS.map((l) => (
                <label key={l.id} className={`flex min-h-[48px] cursor-pointer items-start gap-3 rounded-md border p-3 ${curLevel === l.id ? "border-[var(--wms-accent)]" : "border-[var(--wms-border)]"}`}>
                  <input type="radio" name="cb-level" className="mt-1 h-5 w-5" checked={curLevel === l.id} onChange={() => setLevel(l.id)} />
                  <span><b>{l.label}</b><br /><span className="text-sm text-[var(--wms-muted)]">{l.help}</span></span>
                </label>
              ))}
            </div>
          </fieldset>

          {curLevel !== "blocked" && curLevel !== "admin" && (
            <fieldset className="space-y-2">
              <legend className="text-sm font-semibold">Area limits <span className="font-normal text-[var(--wms-muted)]">(optional — &ldquo;Same as level&rdquo; keeps the level above)</span></legend>
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {AREAS.map(([id, label]) => (
                  <label key={id} className="space-y-1">
                    <span className="text-sm">{label}</span>
                    <select className={inputCls} value={curOver[id] ?? ""} onChange={(e) => {
                      const v = e.target.value as Level | "";
                      const next = { ...curOver };
                      if (v) next[id] = v; else delete next[id];
                      setOverrides(next);
                    }}>
                      <option value="">Same as level</option>
                      {LEVELS.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
                    </select>
                  </label>
                ))}
              </div>
            </fieldset>
          )}

          {needsInvite && (
            <label className="block space-y-1.5">
              <span className="text-sm font-semibold">Mobile number for the invitation</span>
              <input className={inputCls} inputMode="tel" placeholder="+14075550142" value={phone} onChange={(e) => setPhone(e.target.value)} />
              <span className="block text-sm text-[var(--wms-muted)]">CarbonBooks texts sign-in codes to this number. Write it with the country code, like +14075550142.</span>
            </label>
          )}

          <button type="button" className={primaryCls} disabled={busy || (needsInvite && !phone.trim())} onClick={askCode}>
            {busy ? "Sending code…" : "Save — text me a code to confirm"}
          </button>
        </>
      )}

      {step === "code" && (
        <div className="space-y-3">
          <p>We texted a 6-digit code to <b>your</b> phone {hint}. Enter it to confirm this change.</p>
          <input className={`${inputCls} max-w-[220px] text-center text-2xl tracking-[0.4em]`} inputMode="numeric" autoComplete="one-time-code" maxLength={6}
            aria-label="6-digit code" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))} />
          <div className="flex flex-wrap gap-2">
            <button type="button" className={primaryCls} disabled={busy || code.length !== 6} onClick={apply}>{busy ? "Saving…" : "Confirm change"}</button>
            <button type="button" className={secondaryCls} onClick={() => { setStep("edit"); setMsg(null); }}>Cancel</button>
          </div>
        </div>
      )}

      {msg && <Notice ok={msg.ok} text={msg.text} />}
      {invite && (
        <div className="space-y-2 rounded-md border border-[var(--wms-border)] p-3">
          <p className="text-sm"><b>Invitation link</b> — send it to {fullName(user)}. It works once, for 7 days.</p>
          <input className={inputCls} readOnly value={invite} onFocus={(e) => e.currentTarget.select()} aria-label="Invitation link" />
          <button type="button" className={secondaryCls} onClick={() => navigator.clipboard?.writeText(invite)}>Copy link</button>
        </div>
      )}
    </div>
  );
}

function Notice({ ok, text }: { ok: boolean; text: string }) {
  return (
    <div role={ok ? "status" : "alert"} className={`rounded-md border p-3 text-sm ${ok ? "border-emerald-500/40 bg-emerald-500/10" : "border-red-500/40 bg-red-500/10"}`}>
      {text}
    </div>
  );
}
