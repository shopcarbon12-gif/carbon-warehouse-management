"use client";
/**
 * Email Marketing → Audience → Segments (phase 5): saved groups of people by what they did
 * (orders online and in the store, money spent, email opens and clicks, Rewards, birthdays).
 * Every rule must match. The count updates live; a campaign can pick a segment in "Who gets it".
 */
import { useEffect, useState } from "react";
import useSWR from "swr";
import { Plus, Trash2 } from "lucide-react";
import { RULE_KINDS, SEGMENT_IDEAS, ruleText, type SegRule } from "@/lib/email-editor/segments";
import { btn, card, fetcher, field, label, send } from "@/components/marketing/marketing-shared";

export type Segment = { id: string; name: string; rules: SegRule[]; count: number | null };
const nf = new Intl.NumberFormat("en-US");

export function useSegments() {
  return useSWR<{ segments: Segment[] }>("/api/email/segments", fetcher);
}

export function EmailSegments() {
  const { data, error, mutate } = useSegments();
  const [edit, setEdit] = useState<{ id?: string; name: string; rules: SegRule[] } | null>(null);
  return (
    <section className={`${card} flex flex-col gap-3`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-[var(--wms-fg)]">Segments</h3>
          <p className="text-xs text-[var(--wms-muted)]">Groups of people by what they did: orders online and in the store, money spent, opens and clicks, Rewards, birthdays. Pick one in a campaign under “Who gets it”.</p>
        </div>
        <button type="button" className={`${btn} inline-flex items-center gap-1 border-[var(--wms-fg)] bg-[var(--wms-fg)] text-[var(--wms-bg)]`} onClick={() => setEdit({ name: "", rules: [RULE_KINDS[0].make()] })}>
          <Plus size={13} /> New segment
        </button>
      </div>
      {error && <p className="text-xs text-[var(--wms-status-danger-fg)]">{error.message}</p>}
      {edit && (
        <Builder
          initial={edit}
          onDone={() => {
            setEdit(null);
            void mutate();
          }}
        />
      )}
      {!edit && data?.segments.length === 0 && (
        <div className="flex flex-col gap-2">
          <p className="text-xs text-[var(--wms-muted)]">No segments yet. Start from one of these:</p>
          <div className="flex flex-wrap gap-1.5">
            {SEGMENT_IDEAS.map((s) => (
              <button key={s.name} type="button" className={`${btn} border-[var(--wms-border)] normal-case`} onClick={() => setEdit({ name: s.name, rules: s.rules })}>
                {s.name}
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="flex flex-col gap-1.5">
        {data?.segments.map((s) => (
          <div key={s.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-md border border-[var(--wms-border)] px-3 py-2">
            <button type="button" className="min-w-[200px] flex-1 text-left" onClick={() => setEdit({ id: s.id, name: s.name, rules: s.rules })}>
              <span className="block text-sm font-semibold text-[var(--wms-fg)]">{s.name}</span>
              <span className="block text-xs text-[var(--wms-muted)]">{s.rules.map(ruleText).join(" · and · ")}</span>
            </button>
            <span className="font-mono text-sm text-[var(--wms-fg)]">{s.count == null ? "—" : `${nf.format(s.count)} people`}</span>
            <button
              type="button"
              aria-label={`Delete ${s.name}`}
              className="text-[var(--wms-muted)] hover:text-[var(--wms-status-danger-fg)]"
              onClick={async () => {
                if (!window.confirm(`Delete the segment "${s.name}"? Campaigns that used it keep their list.`)) return;
                await fetch(`/api/email/segments/${s.id}`, { method: "DELETE" });
                void mutate();
              }}
            >
              <Trash2 size={14} />
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

function RuleRow({ r, onChange, onRemove }: { r: SegRule; onChange: (r: SegRule) => void; onRemove: () => void }) {
  const num = (v: number | null, set: (n: number | null) => void, opts: { allowEver?: boolean; min?: number; w?: string } = {}) => (
    <input
      className={`${field} ${opts.w ?? "w-20"}`}
      inputMode="numeric"
      value={v ?? ""}
      placeholder={opts.allowEver ? "ever" : ""}
      onChange={(e) => {
        const n = Number(e.target.value.replace(/\D/g, ""));
        set(e.target.value === "" && opts.allowEver ? null : Math.max(opts.min ?? 1, n || opts.min || 1));
      }}
    />
  );
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--wms-fg)]">
      <select className={field} value={r.k} onChange={(e) => onChange(RULE_KINDS.find((x) => x.k === e.target.value)!.make())}>
        {RULE_KINDS.map((k) => (
          <option key={k.k} value={k.k}>
            {k.label}
          </option>
        ))}
      </select>
      {r.k === "ordered" && (
        <>
          <span>at least</span>
          {num(r.min, (n) => onChange({ ...r, min: n ?? 1 }), { w: "w-14" })}
          <span>orders in the last</span>
          {num(r.days, (n) => onChange({ ...r, days: n }), { allowEver: true })}
          <span>days (empty = ever)</span>
        </>
      )}
      {r.k === "no_order" && (
        <>
          <span>no order in the last</span>
          {num(r.days, (n) => onChange({ ...r, days: n ?? 90 }))}
          <span>days</span>
        </>
      )}
      {r.k === "spent" && (
        <>
          <span>$</span>
          {num(r.min, (n) => onChange({ ...r, min: n ?? 1 }))}
          <span>or more in the last</span>
          {num(r.days, (n) => onChange({ ...r, days: n }), { allowEver: true })}
          <span>days (empty = ever)</span>
        </>
      )}
      {r.k === "engaged" && (
        <>
          <select className={field} value={r.what} onChange={(e) => onChange({ ...r, what: e.target.value as "opened" | "clicked" })}>
            <option value="opened">opened</option>
            <option value="clicked">clicked</option>
          </select>
          <span>an email in the last</span>
          {num(r.days, (n) => onChange({ ...r, days: n ?? 30 }))}
          <span>days</span>
        </>
      )}
      {r.k === "not_engaged" && (
        <>
          <span>got emails but opened none in the last</span>
          {num(r.days, (n) => onChange({ ...r, days: n ?? 60 }))}
          <span>days</span>
        </>
      )}
      {r.k === "rewards" && (
        <select className={field} value={r.yes ? "yes" : "no"} onChange={(e) => onChange({ ...r, yes: e.target.value === "yes" })}>
          <option value="yes">is a member</option>
          <option value="no">is not a member</option>
        </select>
      )}
      {r.k === "birthday" && (
        <select className={field} value={String(r.month)} onChange={(e) => onChange({ ...r, month: e.target.value === "this" || e.target.value === "next" ? e.target.value : Number(e.target.value) })}>
          <option value="this">this month</option>
          <option value="next">next month</option>
          {MONTHS.map((m, i) => (
            <option key={m} value={i + 1}>
              {m}
            </option>
          ))}
        </select>
      )}
      <button type="button" aria-label="Remove rule" className="text-[var(--wms-muted)] hover:text-[var(--wms-status-danger-fg)]" onClick={onRemove}>
        <Trash2 size={13} />
      </button>
    </div>
  );
}

function Builder({ initial, onDone }: { initial: { id?: string; name: string; rules: SegRule[] }; onDone: () => void }) {
  const [name, setName] = useState(initial.name);
  const [rules, setRules] = useState<SegRule[]>(initial.rules);
  const [count, setCount] = useState<{ count: number; sample: { email: string; first_name: string | null }[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (!rules.length) return setCount(null);
    const t = setTimeout(() => {
      send<{ count: number; sample: { email: string; first_name: string | null }[] }>("/api/email/segments", "POST", { count: rules })
        .then(setCount)
        .catch((e) => setErr(e instanceof Error ? e.message : String(e)));
    }, 400);
    return () => clearTimeout(t);
  }, [rules]);
  async function save() {
    setBusy(true);
    setErr(null);
    try {
      if (initial.id) {
        const r = await fetch(`/api/email/segments/${initial.id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, rules }) });
        const j = (await r.json()) as { error?: string };
        if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      } else await send("/api/email/segments", "POST", { name, rules });
      onDone();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="flex flex-col gap-2.5 rounded-md border border-[var(--wms-fg)] p-3">
      <label className="flex flex-col gap-1">
        <span className={label}>Segment name</span>
        <input className={field} value={name} maxLength={80} placeholder="e.g. Best customers" onChange={(e) => setName(e.target.value)} />
      </label>
      <span className={label}>People who match every rule</span>
      {rules.map((r, i) => (
        <RuleRow key={i} r={r} onChange={(x) => setRules(rules.map((y, j) => (j === i ? x : y)))} onRemove={() => setRules(rules.filter((_, j) => j !== i))} />
      ))}
      <button type="button" className={`${btn} self-start border-[var(--wms-border)]`} onClick={() => setRules([...rules, RULE_KINDS[0].make()])} disabled={rules.length >= 12}>
        + And another rule
      </button>
      <p className="text-sm text-[var(--wms-fg)]">
        {count ? <b>{nf.format(count.count)} people right now</b> : "Counting…"}
        {count && count.sample.length > 0 && <span className="text-xs text-[var(--wms-muted)]"> · e.g. {count.sample.slice(0, 4).map((x) => x.first_name || x.email).join(", ")}</span>}
      </p>
      <p className="text-[0.7rem] text-[var(--wms-muted)]">Unsubscribed, bounced and excluded addresses are never counted. Orders come from shopcarbon.com and Carbon POS (synced every 5 minutes, the last 400 days).</p>
      {err && <p className="text-xs text-[var(--wms-status-danger-fg)]">{err}</p>}
      <div className="flex gap-1.5">
        <button type="button" className={`${btn} border-[var(--wms-fg)] bg-[var(--wms-fg)] text-[var(--wms-bg)]`} disabled={busy || !name.trim() || !rules.length} onClick={() => void save()}>
          {busy ? "Saving…" : "Save segment"}
        </button>
        <button type="button" className={`${btn} border-[var(--wms-border)]`} onClick={onDone}>
          Cancel
        </button>
      </div>
    </div>
  );
}
