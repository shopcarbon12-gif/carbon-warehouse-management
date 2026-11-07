"use client";

import { useEffect, useState } from "react";
import useSWR from "swr";
import { btn, card, fetcher, field, label, send } from "@/components/marketing/marketing-shared";

type Settings = {
  fromName: string;
  fromEmail: string;
  replyTo: string;
  postalAddress: string;
  sendingEnabled: boolean;
  maxPerMinute: number;
  bouncePausePct: number;
  snsTopicArn: string | null;
};
type Ses = {
  configured: boolean;
  region: string;
  production: boolean | null;
  maxPerSecond: number | null;
  max24h: number | null;
  sent24h: number | null;
  enforcement: string | null;
  identity: { domain: string; mailFromDomain: string; exists: boolean; verified: boolean; dkim: string | null; mailFrom: string | null };
  tracking: { topicArn: string | null; subscription: string | null };
  records: { type: string; name: string; value: string; purpose: string; status: string }[];
  dmarc: string | null;
  error?: string;
};

const nf = new Intl.NumberFormat("en-US");

function Check({ ok, warn, children }: { ok: boolean; warn?: boolean; children: React.ReactNode }) {
  const tone = ok ? "text-emerald-700 dark:text-emerald-300" : warn ? "text-amber-700 dark:text-amber-300" : "text-[var(--wms-status-danger-fg)]";
  return (
    <li className="flex gap-2 text-xs">
      <span className={`${tone} w-4 shrink-0 font-bold`}>{ok ? "✓" : warn ? "!" : "✗"}</span>
      <span className="min-w-0 text-[var(--wms-fg)]">{children}</span>
    </li>
  );
}

function copy(text: string) {
  navigator.clipboard?.writeText(text).catch(() => {});
}

export function EmailSettingsPanel() {
  const { data, error, mutate } = useSWR<{ settings: Settings; ses: Ses }>("/api/email/settings", fetcher);
  const [form, setForm] = useState<Settings | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ text: string; err?: boolean } | null>(null);
  useEffect(() => {
    if (data && !form) setForm(data.settings);
  }, [data, form]);
  const ses = data?.ses;

  async function run(name: string, fn: () => Promise<void>) {
    setBusy(name);
    setMsg(null);
    try {
      await fn();
    } catch (e) {
      setMsg({ text: e instanceof Error ? e.message : "Something went wrong", err: true });
    } finally {
      setBusy(null);
    }
  }

  const setup = () =>
    run("setup", async () => {
      const r = await send<{ ses: Ses }>("/api/email/settings/ses", "POST");
      await mutate(data ? { ...data, ses: r.ses } : undefined, false);
      setMsg({ text: "Amazon SES is set up. Add the DNS records below; verification usually takes 5–60 minutes after they are added." });
    });
  const save = () =>
    run("save", async () => {
      if (!form) return;
      const r = await fetch("/api/email/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fromName: form.fromName,
          fromEmail: form.fromEmail,
          replyTo: form.replyTo,
          postalAddress: form.postalAddress,
          sendingEnabled: form.sendingEnabled,
          maxPerMinute: Number(form.maxPerMinute),
          bouncePausePct: Number(form.bouncePausePct),
        }),
      });
      const j = (await r.json().catch(() => ({}))) as { error?: string; settings?: Settings };
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setForm(j.settings ?? form);
      await mutate();
      setMsg({ text: "Saved." });
    });

  return (
    <div className="flex min-w-0 flex-col gap-3">
      {msg && <p className={`text-xs ${msg.err ? "text-[var(--wms-status-danger-fg)]" : "text-emerald-700 dark:text-emerald-300"}`}>{msg.text}</p>}
      {error && <p className="text-xs text-[var(--wms-status-danger-fg)]">{error.message}</p>}

      <section className={card}>
        <div className="flex flex-wrap items-center justify-between gap-2 pb-2">
          <span className={label}>Amazon SES (sending)</span>
          <div className="flex gap-2">
            <button type="button" className={`${btn} border-[var(--wms-border)]`} disabled={!!busy} onClick={() => run("check", async () => void (await mutate()))}>
              {busy === "check" ? "Checking…" : "Check again"}
            </button>
            <button type="button" className={`${btn} border-[var(--wms-fg)] bg-[var(--wms-fg)] text-[var(--wms-bg)]`} disabled={!!busy || !ses?.configured} onClick={setup}>
              {busy === "setup" ? "Setting up…" : "Set up Amazon SES"}
            </button>
          </div>
        </div>
        {!ses ? (
          <p className="text-xs text-[var(--wms-muted)]">Loading…</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            <Check ok={ses.configured}>
              {ses.configured ? `AWS keys are on the server (region ${ses.region}).` : "AWS keys are not on the server yet: AWS_SES_ACCESS_KEY_ID and AWS_SES_SECRET_ACCESS_KEY (Coolify, web app)."}
            </Check>
            {ses.configured && (
              <>
                <Check ok={!!ses.production} warn={ses.production === false}>
                  {ses.production
                    ? `Production access: on. Up to ${nf.format(ses.max24h ?? 0)} emails a day (${nf.format(ses.sent24h ?? 0)} sent in the last 24 h), ${ses.maxPerSecond ?? "?"} per second.`
                    : "Sandbox mode: Amazon only delivers to verified addresses. In the AWS console, SES → Account dashboard → Request production access (usually approved within a day)."}
                </Check>
                <Check ok={ses.identity.verified} warn={ses.identity.exists && !ses.identity.verified}>
                  {ses.identity.verified
                    ? `${ses.identity.domain} is verified in Amazon SES (DKIM).`
                    : ses.identity.exists
                      ? `${ses.identity.domain} is waiting for its DNS records (DKIM: ${ses.identity.dkim ?? "pending"}).`
                      : `${ses.identity.domain} is not added to Amazon SES yet. Press "Set up Amazon SES".`}
                </Check>
                <Check ok={ses.identity.mailFrom === "SUCCESS"} warn>
                  {ses.identity.mailFrom === "SUCCESS" ? `Bounce address ${ses.identity.mailFromDomain} is working.` : `Bounce address ${ses.identity.mailFromDomain}: ${ses.identity.mailFrom ?? "not set"}.`}
                </Check>
                <Check ok={ses.tracking.subscription === "confirmed"} warn={ses.tracking.subscription === "pending"}>
                  {ses.tracking.subscription === "confirmed"
                    ? "Delivery tracking (opens, clicks, bounces, complaints) is connected."
                    : ses.tracking.subscription === "pending"
                      ? "Delivery tracking is waiting for Amazon to confirm (happens by itself within a minute)."
                      : "Delivery tracking is not connected."}
                </Check>
                <Check ok={!!ses.dmarc} warn>
                  {ses.dmarc ? `DMARC is set for shopcarbon.com (${ses.dmarc}).` : "shopcarbon.com has no DMARC record (add the TXT record below)."}
                </Check>
                {ses.enforcement && ses.enforcement !== "HEALTHY" && <Check ok={false}>Amazon account status: {ses.enforcement}.</Check>}
                {ses.error && <Check ok={false}>{ses.error}</Check>}
              </>
            )}
          </ul>
        )}
      </section>

      {ses && ses.records.length > 0 && (
        <section className={card}>
          <span className={`${label} block pb-1`}>DNS records to add (NameBright → shopcarbon.com → DNS)</span>
          <p className="pb-2 text-xs text-[var(--wms-muted)]">Add each record exactly as shown. In NameBright the &quot;name&quot; is usually typed without &quot;.shopcarbon.com&quot; at the end.</p>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-xs">
              <thead>
                <tr className="text-left">
                  <th className={`${label} py-1 pr-2`}>Type</th>
                  <th className={`${label} py-1 pr-2`}>Name</th>
                  <th className={`${label} py-1 pr-2`}>Value</th>
                  <th className={`${label} py-1 pr-2`}>Status</th>
                </tr>
              </thead>
              <tbody>
                {ses.records.map((r) => (
                  <tr key={r.type + r.name + r.value} className="border-t border-[var(--wms-border)] align-top">
                    <td className="py-1.5 pr-2 font-mono text-[var(--wms-fg)]">{r.type}</td>
                    <td className="py-1.5 pr-2">
                      <button type="button" className="break-all text-left font-mono text-[var(--wms-fg)] underline decoration-dotted max-md:py-2" title="Copy" onClick={() => copy(r.name)}>
                        {r.name}
                      </button>
                      <span className="block text-[0.68rem] text-[var(--wms-muted)]">{r.purpose}</span>
                    </td>
                    <td className="py-1.5 pr-2">
                      <button type="button" className="break-all text-left font-mono text-[var(--wms-fg)] underline decoration-dotted max-md:py-2" title="Copy" onClick={() => copy(r.value)}>
                        {r.value}
                      </button>
                    </td>
                    <td className="py-1.5 pr-2 font-mono text-[var(--wms-muted)]">{r.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {form && (
        <section className={card}>
          <span className={`${label} block pb-2`}>Sender</span>
          <div className="grid gap-2 md:grid-cols-2">
            {(
              [
                ["fromName", "From name", "Carbon"],
                ["fromEmail", "From address (must be on a verified domain)", "vip@shopcarbon.com"],
                ["replyTo", "Replies go to", "support@shopcarbon.com"],
                ["postalAddress", "Postal address in every footer (required by law)", ""],
              ] as [keyof Settings, string, string][]
            ).map(([k, l, ph]) => (
              <label key={k} className="flex min-w-0 flex-col gap-1">
                <span className={label}>{l}</span>
                <input id={`email-set-${k}`} className={field} value={String(form[k] ?? "")} placeholder={ph} onChange={(e) => setForm({ ...form, [k]: e.target.value })} />
              </label>
            ))}
            <label className="flex min-w-0 flex-col gap-1">
              <span className={label}>Most emails per minute</span>
              <input
                id="email-set-rate"
                className={field}
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                autoComplete="off"
                value={String(form.maxPerMinute)}
                onChange={(e) => setForm({ ...form, maxPerMinute: Number(e.target.value.replace(/\D/g, "")) || 0 })}
              />
            </label>
            <label className="flex min-w-0 flex-col gap-1">
              <span className={label}>Pause a campaign by itself when bounces reach (%)</span>
              <input
                id="email-set-bounce"
                className={field}
                type="text"
                inputMode="decimal"
                autoComplete="off"
                value={String(form.bouncePausePct)}
                onChange={(e) => setForm({ ...form, bouncePausePct: Number(e.target.value.replace(/[^\d.]/g, "")) || 0 })}
              />
            </label>
            <label className="flex items-center gap-2 text-xs text-[var(--wms-fg)]">
              <input id="email-set-enabled" type="checkbox" className="max-md:h-5 max-md:w-5" checked={form.sendingEnabled} onChange={(e) => setForm({ ...form, sendingEnabled: e.target.checked })} />
              Sending switched on (off stops every campaign right away)
            </label>
          </div>
          <div className="pt-3">
            <button type="button" className={`${btn} border-[var(--wms-fg)] bg-[var(--wms-fg)] text-[var(--wms-bg)]`} disabled={!!busy} onClick={save}>
              {busy === "save" ? "Saving…" : "Save"}
            </button>
          </div>
        </section>
      )}
    </div>
  );
}
