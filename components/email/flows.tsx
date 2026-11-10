"use client";
/**
 * Email Marketing → Flows (phase 4): automatic emails, built like Klaviyo's flow builder.
 * The list shows every flow with its numbers; a flow opens as a top-to-bottom diagram:
 * the trigger, then waits, emails and "stop if" steps, with + between them to add more.
 * The selected step is edited in the panel on the right. Changes save by themselves.
 * ?flow=<id> keeps a flow open on refresh.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import useSWR from "swr";
import { useSearchParams } from "next/navigation";
import { ArrowLeft, Check, CircleStop, Clock, Loader2, Mail, Pause, Pencil, Play, Plus, Send, Trash2, Zap } from "lucide-react";
import { FLOW_IDEAS, STOP_LABEL, TRIGGER_LABEL, fid, flowProblems, triggerText, waitText, type EmailStep, type FlowSettings, type FlowStep, type Trigger } from "@/lib/email-editor/flows";
import { STARTERS } from "@/lib/email-editor/prebuilt";
import { btn, card, fetcher, field, label, send } from "@/components/marketing/marketing-shared";
import { EmailEditor } from "./editor/editor";

type StepStats = {
  sent: number;
  skipped: number;
  delivered: number;
  opened: number;
  clicked: number;
  orders: number;
  revenue: number;
};
type Stats = {
  inside: number;
  entered: number;
  sent: number;
  opened: number;
  clicked: number;
  orders: number;
  revenue: number;
  steps: Record<string, StepStats>;
};
type Flow = {
  id: string;
  name: string;
  kind: string;
  trigger: Trigger;
  steps: FlowStep[];
  settings: FlowSettings;
  status: "draft" | "live" | "paused";
  live_since: string | null;
  updated_at: string;
};
type Person = {
  email: string;
  first_name: string | null;
  status: string;
  exit_reason: string | null;
  step_index: number;
  next_at: string;
  started_at: string;
};
type EmailRow = { id: string; title: string; updated_at: string };

const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : "—");
const money = (n: number) => `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
const when = (iso: string) =>
  new Date(iso).toLocaleString("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

const STATUS: Record<Flow["status"], { text: string; cls: string }> = {
  live: {
    text: "Live",
    cls: "border-emerald-500/50 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  },
  paused: {
    text: "Paused",
    cls: "border-amber-500/50 bg-amber-500/15 text-amber-700 dark:text-amber-300",
  },
  draft: {
    text: "Draft",
    cls: "border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] text-[var(--wms-muted)]",
  },
};
const Badge = ({ s }: { s: Flow["status"] }) => <span className={`rounded border px-1.5 py-0.5 font-mono text-[0.66rem] uppercase tracking-wide ${STATUS[s].cls}`}>{STATUS[s].text}</span>;

export function EmailFlows() {
  const flowId = useSearchParams().get("flow");
  const [open, setOpenState] = useState<string | null>(flowId);
  const setOpen = (v: string | null) => {
    const u = new URL(window.location.href);
    if (v) u.searchParams.set("flow", v);
    else u.searchParams.delete("flow");
    window.history.replaceState(null, "", u.toString());
    setOpenState(v);
  };
  return open ? <FlowPage id={open} onBack={() => setOpen(null)} /> : <FlowList onOpen={setOpen} />;
}

/* ------------------------------------------------------------------ list */

function FlowList({ onOpen }: { onOpen: (id: string) => void }) {
  const { data, error, mutate } = useSWR<{
    flows: (Flow & { stats: Stats })[];
  }>("/api/email/flows", fetcher, { refreshInterval: 60_000 });
  const [choosing, setChoosing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  async function create(kind: string) {
    setBusy(kind);
    setMsg(null);
    try {
      const r = await send<{ id: string }>("/api/email/flows", "POST", {
        kind,
      });
      await mutate();
      onOpen(r.id);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }
  const have = new Set(data?.flows.map((f) => f.kind));
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-[var(--wms-muted)]">Automatic emails: they go out by themselves when someone signs up, leaves a checkout, orders, or has not ordered for a while.</p>
        <button type="button" className={`${btn} inline-flex items-center gap-1 border-[var(--wms-fg)] bg-[var(--wms-fg)] text-[var(--wms-bg)]`} onClick={() => setChoosing(!choosing)}>
          <Plus size={13} /> New flow
        </button>
      </div>
      {(choosing || data?.flows.length === 0) && (
        <section className={`${card} flex flex-col gap-3`}>
          <h3 className="text-sm font-semibold text-[var(--wms-fg)]">Start from a ready-made flow</h3>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {FLOW_IDEAS.map((idea) => {
              const d = idea.make();
              return (
                <button
                  key={idea.kind}
                  type="button"
                  disabled={!!busy}
                  onClick={() => void create(idea.kind)}
                  className="flex flex-col gap-2 rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] p-3 text-left hover:border-[var(--wms-fg)] disabled:opacity-50"
                >
                  <span className="flex items-center justify-between gap-2">
                    <span className="text-sm font-semibold text-[var(--wms-fg)]">{busy === idea.kind ? "Creating…" : idea.name}</span>
                    {have.has(idea.kind) && <span className="text-[0.66rem] text-[var(--wms-muted)]">you have one</span>}
                  </span>
                  <span className="text-xs text-[var(--wms-muted)]">{idea.description}</span>
                  <MiniDiagram trigger={d.trigger} steps={d.steps} />
                </button>
              );
            })}
          </div>
          <button type="button" disabled={!!busy} onClick={() => void create("custom")} className={`${btn} self-start border-[var(--wms-border)]`}>
            {busy === "custom" ? "Creating…" : "Build your own"}
          </button>
          <p className="text-[0.7rem] text-[var(--wms-muted)]">
            A new flow starts as a draft with its emails already made from the matching starters. Nothing is sent until you press Turn on, and only what happens after that counts.
          </p>
        </section>
      )}
      {msg && <p className="text-xs text-[var(--wms-status-danger-fg)]">{msg}</p>}
      {error && <p className="text-xs text-[var(--wms-status-danger-fg)]">{error.message}</p>}
      {!data && !error && <p className="text-xs text-[var(--wms-muted)]">Loading…</p>}
      <div className="flex flex-col gap-2">
        {data?.flows.map((f) => (
          <button key={f.id} type="button" onClick={() => onOpen(f.id)} className={`${card} flex flex-wrap items-center gap-x-6 gap-y-2 text-left hover:border-[var(--wms-fg)]`}>
            <span className="flex min-w-[220px] flex-1 flex-col gap-0.5">
              <span className="flex items-center gap-2">
                <span className="text-sm font-semibold text-[var(--wms-fg)]">{f.name}</span>
                <Badge s={f.status} />
              </span>
              <span className="text-xs text-[var(--wms-muted)]">{triggerText(f.trigger)}</span>
            </span>
            <Num k="In it now" v={String(f.stats.inside)} />
            <Num k="Emails sent" v={String(f.stats.sent)} />
            <Num k="Opened" v={pct(f.stats.opened, f.stats.sent)} />
            <Num k="Clicked" v={pct(f.stats.clicked, f.stats.sent)} />
            <Num k="Orders" v={String(f.stats.orders)} />
            <Num k="Sales" v={money(f.stats.revenue)} />
          </button>
        ))}
      </div>
    </div>
  );
}

const Num = ({ k, v }: { k: string; v: string }) => (
  <span className="flex flex-col">
    <span className={label}>{k}</span>
    <span className="font-mono text-sm text-[var(--wms-fg)]">{v}</span>
  </span>
);

function MiniDiagram({ trigger, steps }: { trigger: Trigger; steps: FlowStep[] }) {
  return (
    <span className="flex flex-col items-start gap-1 border-l-2 border-[var(--wms-border)] pl-2 text-[0.7rem] text-[var(--wms-muted)]">
      <span className="font-semibold text-[var(--wms-fg)]">⚡ {TRIGGER_LABEL[trigger.type]}</span>
      {steps.map((s) => (
        <span key={s.id}>{s.type === "wait" ? `⏱ ${waitText(s)}` : s.type === "stop" ? "⛔ Stop if they ordered" : `✉ ${s.name}`}</span>
      ))}
    </span>
  );
}

/* ------------------------------------------------------------------ one flow */

type Sel = { kind: "trigger" } | { kind: "settings" } | { kind: "step"; id: string } | null;

function FlowPage({ id, onBack }: { id: string; onBack: () => void }) {
  const { data, error, mutate } = useSWR<{
    flow: Flow;
    stats: Stats;
    people: Person[];
  }>(`/api/email/flows/${id}`, fetcher, { refreshInterval: 60_000 });
  const emails = useSWR<{ emails: EmailRow[] }>("/api/email/editor", fetcher);
  const [flow, setFlow] = useState<Flow | null>(null);
  const [sel, setSel] = useState<Sel>({ kind: "trigger" });
  const [save, setSave] = useState<"saved" | "saving" | string>("saved");
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (data?.flow && !flow) setFlow(data.flow);
  }, [data, flow]);

  const put = useCallback(
    async (f: Flow) => {
      setSave("saving");
      try {
        const r = await fetch(`/api/email/flows/${id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: f.name,
            trigger: f.trigger,
            steps: f.steps,
            settings: f.settings,
          }),
        });
        const j = (await r.json()) as { flow?: Flow; error?: string };
        if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
        setSave("saved");
        void mutate();
      } catch (e) {
        setSave(e instanceof Error ? e.message : String(e));
      }
    },
    [id, mutate],
  );
  const change = (f: Flow) => {
    setFlow(f);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void put(f), 700);
  };

  if (error) return <p className="text-xs text-[var(--wms-status-danger-fg)]">{error.message}</p>;
  if (!flow || !data) return <p className="text-xs text-[var(--wms-muted)]">Loading…</p>;

  const setStep = (s: FlowStep) => change({ ...flow, steps: flow.steps.map((x) => (x.id === s.id ? s : x)) });
  const addAt = (i: number, type: FlowStep["type"]) => {
    const s: FlowStep =
      type === "wait"
        ? { id: fid(), type: "wait", amount: 1, unit: "days" }
        : type === "stop"
          ? { id: fid(), type: "stop", if: "ordered" }
          : {
              id: fid(),
              type: "email",
              name: "New email",
              designId: null,
              subject: "",
              preheader: "",
              offer: null,
              live: true,
            };
    const steps = [...flow.steps];
    steps.splice(i, 0, s);
    change({ ...flow, steps });
    setSel({ kind: "step", id: s.id });
  };
  const remove = (sid: string) => {
    change({ ...flow, steps: flow.steps.filter((x) => x.id !== sid) });
    setSel(null);
  };
  const move = (sid: string, d: -1 | 1) => {
    const i = flow.steps.findIndex((x) => x.id === sid);
    const j = i + d;
    if (i < 0 || j < 0 || j >= flow.steps.length) return;
    const steps = [...flow.steps];
    [steps[i], steps[j]] = [steps[j], steps[i]];
    change({ ...flow, steps });
  };
  async function status(s: Flow["status"]) {
    if (s === "live" && !window.confirm(`Turn on "${flow!.name}"? From now on, everyone who ${TRIGGER_LABEL[flow!.trigger.type].toLowerCase()} gets these emails. Nothing that happened before now counts.`)) return;
    if (s === "draft" && !window.confirm("Back to draft? The people inside leave the flow (they get no more emails from it).")) return;
    setBusy(s);
    setMsg(null);
    try {
      if (timer.current) {
        clearTimeout(timer.current);
        await put(flow!);
      }
      const r = await send<{ flow: Flow }>(`/api/email/flows/${id}/action`, "POST", { action: "status", status: s });
      setFlow(r.flow);
      void mutate();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }
  async function del() {
    if (!window.confirm(`Delete "${flow!.name}"? People inside leave it; its emails stay in Emails.`)) return;
    await fetch(`/api/email/flows/${id}`, { method: "DELETE" });
    onBack();
  }
  const problems = flowProblems(flow);
  const selStep = sel?.kind === "step" ? flow.steps.find((s) => s.id === sel.id) : null;
  const titles = new Map(emails.data?.emails.map((e) => [e.id, e.title]) ?? []);

  return (
    <div className="flex min-w-0 flex-col gap-3">
      {editing && (
        <EmailEditor
          id={editing}
          onClose={() => {
            setEditing(null);
            void emails.mutate();
          }}
        />
      )}
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={onBack} aria-label="All flows" className="grid h-8 w-8 place-items-center rounded text-[var(--wms-muted)] hover:text-[var(--wms-fg)]">
          <ArrowLeft size={17} />
        </button>
        <input value={flow.name} maxLength={80} onChange={(e) => change({ ...flow, name: e.target.value })} aria-label="Flow name" className={`${field} w-[min(320px,60vw)] text-sm font-semibold`} />
        <Badge s={flow.status} />
        <span className="text-[0.72rem] text-[var(--wms-muted)]">
          {save === "saved" ? (
            <>
              <Check size={12} className="inline" /> Saved
            </>
          ) : save === "saving" ? (
            "Saving…"
          ) : (
            <span className="text-[var(--wms-status-danger-fg)]">{save}</span>
          )}
        </span>
        <div className="ml-auto flex flex-wrap gap-1.5">
          {flow.status !== "live" && (
            <button
              type="button"
              disabled={!!busy || problems.length > 0}
              title={problems.join(" ")}
              onClick={() => void status("live")}
              className={`${btn} inline-flex items-center gap-1 border-emerald-600 bg-emerald-600 text-white`}
            >
              <Play size={12} /> {busy === "live" ? "Turning on…" : flow.status === "paused" ? "Resume" : "Turn on"}
            </button>
          )}
          {flow.status === "live" && (
            <button type="button" disabled={!!busy} onClick={() => void status("paused")} className={`${btn} inline-flex items-center gap-1 border-[var(--wms-border)]`}>
              <Pause size={12} /> Pause
            </button>
          )}
          {flow.status !== "draft" && (
            <button type="button" disabled={!!busy} onClick={() => void status("draft")} className={`${btn} border-[var(--wms-border)]`}>
              Back to draft
            </button>
          )}
          <button type="button" onClick={() => setSel({ kind: "settings" })} className={`${btn} border-[var(--wms-border)]`}>
            Settings
          </button>
          <button type="button" onClick={() => void del()} aria-label="Delete flow" className={`${btn} border-[var(--wms-border)] text-[var(--wms-status-danger-fg)]`}>
            <Trash2 size={12} />
          </button>
        </div>
      </div>
      {msg && <p className="text-xs text-[var(--wms-status-danger-fg)]">{msg}</p>}
      {flow.status !== "live" && problems.length > 0 && <p className="text-xs text-[var(--wms-muted)]">Before turning on: {problems.join(" ")}</p>}
      <div className="grid min-w-0 gap-3 lg:grid-cols-[minmax(0,1fr)_380px]">
        {/* the diagram */}
        <section className="flex min-w-0 flex-col items-center rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-3 py-5">
          <Node selected={sel?.kind === "trigger"} onClick={() => setSel({ kind: "trigger" })} dark>
            <span className="flex items-center gap-2 text-[0.8rem] font-semibold">
              <Zap size={15} /> Trigger
            </span>
            <span className="text-[0.78rem] opacity-80">{triggerText(flow.trigger)}</span>
            {data.stats.entered > 0 && (
              <span className="text-[0.7rem] opacity-70">
                {data.stats.entered} entered · {data.stats.inside} in it now
              </span>
            )}
          </Node>
          <Adder onAdd={(t) => addAt(0, t)} />
          {flow.steps.map((s, i) => (
            <div key={s.id} className="flex w-full flex-col items-center">
              <StepNode
                step={s}
                selected={sel?.kind === "step" && sel.id === s.id}
                onClick={() => setSel({ kind: "step", id: s.id })}
                title={s.type === "email" && s.designId ? titles.get(s.designId) : undefined}
                stats={data.stats.steps[s.id]}
              />
              <Adder onAdd={(t) => addAt(i + 1, t)} />
            </div>
          ))}
          <span className="rounded-full border border-[var(--wms-border)] px-3 py-1 font-mono text-[0.66rem] uppercase tracking-wide text-[var(--wms-muted)]">End</span>
        </section>
        {/* the panel */}
        <aside className={`${card} flex h-fit flex-col gap-3 lg:sticky lg:top-3`}>
          {sel?.kind === "trigger" && <TriggerPanel flow={flow} onChange={(t) => change({ ...flow, trigger: t })} />}
          {sel?.kind === "settings" && <SettingsPanel s={flow.settings} onChange={(st) => change({ ...flow, settings: st })} />}
          {selStep && (
            <StepPanel
              key={selStep.id}
              step={selStep}
              flowId={id}
              emails={emails.data?.emails ?? []}
              onChange={setStep}
              onRemove={() => remove(selStep.id)}
              onMove={(d) => move(selStep.id, d)}
              onEdit={(designId) => setEditing(designId)}
              onEmailsChanged={() => void emails.mutate()}
              stats={data.stats.steps[selStep.id]}
              trigger={flow.trigger}
            />
          )}
          {!sel && <p className="text-xs text-[var(--wms-muted)]">Click a step to change it, or + to add one.</p>}
        </aside>
      </div>
      <section className={`${card} flex flex-col gap-2`}>
        <h3 className="text-sm font-semibold text-[var(--wms-fg)]">Who is in it (latest 50)</h3>
        {!data.people.length && (
          <p className="text-xs text-[var(--wms-muted)]">
            Nobody yet.
            {flow.status !== "live" ? " People enter once the flow is on." : ""}
          </p>
        )}
        {!!data.people.length && (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-left text-xs">
              <thead className={label}>
                <tr>
                  <th className="py-1 pr-3">Person</th>
                  <th className="py-1 pr-3">Entered</th>
                  <th className="py-1 pr-3">Where they are</th>
                </tr>
              </thead>
              <tbody className="text-[var(--wms-fg)]">
                {data.people.map((p) => (
                  <tr key={p.email + p.started_at} className="border-t border-[var(--wms-border)]">
                    <td className="py-1.5 pr-3">
                      {p.first_name ? `${p.first_name} · ` : ""}
                      {p.email}
                    </td>
                    <td className="py-1.5 pr-3">{when(p.started_at)}</td>
                    <td className="py-1.5 pr-3 text-[var(--wms-muted)]">
                      {p.status === "active" ? `Step ${p.step_index + 1}, next ${when(p.next_at)}` : p.status === "done" ? "Finished" : p.exit_reason ? `Left: ${p.exit_reason}` : p.status}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function Node({ children, selected, onClick, dark }: { children: React.ReactNode; selected: boolean; onClick: () => void; dark?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full max-w-[380px] flex-col gap-1 rounded-lg border p-3 text-left shadow-sm transition-colors ${
        dark ? "border-[#111] bg-[#111] text-white" : "border-[var(--wms-border)] bg-[var(--wms-surface)] text-[var(--wms-fg)]"
      } ${selected ? "ring-2 ring-[#2F6FED]" : "hover:border-[var(--wms-fg)]"}`}
    >
      {children}
    </button>
  );
}

function StepNode({ step, selected, onClick, title, stats }: { step: FlowStep; selected: boolean; onClick: () => void; title?: string; stats?: StepStats }) {
  if (step.type === "wait")
    return (
      <button
        type="button"
        onClick={onClick}
        className={`flex items-center gap-1.5 rounded-full border bg-[var(--wms-surface)] px-3 py-1.5 text-[0.78rem] text-[var(--wms-fg)] ${selected ? "border-[#2F6FED] ring-2 ring-[#2F6FED]" : "border-[var(--wms-border)] hover:border-[var(--wms-fg)]"}`}
      >
        <Clock size={13} /> {waitText(step)}
      </button>
    );
  if (step.type === "stop")
    return (
      <button
        type="button"
        onClick={onClick}
        className={`flex items-center gap-1.5 rounded-md border bg-[var(--wms-surface)] px-3 py-1.5 text-[0.76rem] text-[var(--wms-fg)] ${selected ? "border-[#2F6FED] ring-2 ring-[#2F6FED]" : "border-dashed border-[var(--wms-border)] hover:border-[var(--wms-fg)]"}`}
      >
        <CircleStop size={13} /> {STOP_LABEL[step.if]}
      </button>
    );
  return (
    <Node selected={selected} onClick={onClick}>
      <span className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-2 text-[0.8rem] font-semibold">
          <Mail size={14} /> {step.name}
        </span>
        {!step.live && <span className="rounded border border-[var(--wms-border)] px-1 text-[0.62rem] uppercase text-[var(--wms-muted)]">Off</span>}
      </span>
      <span className="truncate text-[0.76rem] text-[var(--wms-muted)]">{step.subject || "No subject line yet"}</span>
      <span className="truncate text-[0.7rem] text-[var(--wms-muted)]">
        {step.designId ? `Email: ${title ?? "…"}` : "No email picked"}
        {step.offer ? ` · own code ${step.offer.kind === "percent" ? `${step.offer.amount}%` : `$${step.offer.amount}`} off` : ""}
      </span>
      {stats && stats.sent > 0 && (
        <span className="font-mono text-[0.68rem] text-[var(--wms-muted)]">
          {stats.sent} sent · {pct(stats.opened, stats.sent)} opened · {pct(stats.clicked, stats.sent)} clicked · {stats.orders} orders
        </span>
      )}
    </Node>
  );
}

function Adder({ onAdd }: { onAdd: (t: FlowStep["type"]) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative flex flex-col items-center py-1">
      <span className="h-3 w-px bg-[var(--wms-border)]" />
      <button
        type="button"
        title="Add a step"
        aria-label="Add a step"
        onClick={() => setOpen(!open)}
        className="grid h-6 w-6 place-items-center rounded-full border border-[var(--wms-border)] bg-[var(--wms-surface)] text-[var(--wms-muted)] hover:border-[var(--wms-fg)] hover:text-[var(--wms-fg)]"
      >
        <Plus size={13} />
      </button>
      <span className="h-3 w-px bg-[var(--wms-border)]" />
      {open && (
        <div className="absolute top-8 z-20 flex flex-col overflow-hidden rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface)] text-[0.78rem] shadow-lg">
          {(
            [
              ["email", "Email", <Mail key="m" size={13} />],
              ["wait", "Time delay", <Clock key="c" size={13} />],
              ["stop", "Stop if…", <CircleStop key="s" size={13} />],
            ] as const
          ).map(([t, l, icon]) => (
            <button
              key={t}
              type="button"
              onClick={() => {
                setOpen(false);
                onAdd(t);
              }}
              className="flex items-center gap-2 px-3 py-2 text-left text-[var(--wms-fg)] hover:bg-[var(--wms-surface-elevated)]"
            >
              {icon} {l}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ panels */

const Row = ({ k, children }: { k: string; children: React.ReactNode }) => (
  <label className="flex flex-col gap-1">
    <span className={label}>{k}</span>
    {children}
  </label>
);

function TriggerPanel({ flow, onChange }: { flow: Flow; onChange: (t: Trigger) => void }) {
  const t = flow.trigger;
  const locked = flow.status !== "draft";
  return (
    <>
      <h3 className="text-sm font-semibold text-[var(--wms-fg)]">Trigger: what starts this flow</h3>
      <Row k="Starts when someone">
        <select
          className={field}
          disabled={locked}
          value={t.type}
          onChange={(e) => {
            const v = e.target.value as Trigger["type"];
            onChange(v === "order" ? { type: "order", first: false, where: "both" } : v === "winback" ? { type: "winback", days: 90 } : { type: v });
          }}
        >
          {(Object.keys(TRIGGER_LABEL) as Trigger["type"][]).map((k) => (
            <option key={k} value={k}>
              {TRIGGER_LABEL[k]}
            </option>
          ))}
        </select>
      </Row>
      {t.type === "order" && (
        <>
          <Row k="Where">
            <select
              className={field}
              disabled={locked}
              value={t.where}
              onChange={(e) =>
                onChange({
                  ...t,
                  where: e.target.value as "online" | "store" | "both",
                })
              }
            >
              <option value="both">Online or in the store</option>
              <option value="online">Online only (shopcarbon.com)</option>
              <option value="store">In the store only (Carbon POS)</option>
            </select>
          </Row>
          <label className="flex items-center gap-2 text-xs text-[var(--wms-fg)]">
            <input type="checkbox" disabled={locked} checked={t.first} onChange={(e) => onChange({ ...t, first: e.target.checked })} /> Only their first order
          </label>
        </>
      )}
      {t.type === "winback" && (
        <Row k="Days since their last order">
          <input
            type="number"
            className={field}
            disabled={locked}
            min={14}
            max={730}
            value={t.days}
            onChange={(e) =>
              onChange({
                ...t,
                days: Math.max(14, Math.min(730, Number(e.target.value) || 90)),
              })
            }
          />
        </Row>
      )}
      <p className="text-[0.72rem] leading-relaxed text-[var(--wms-muted)]">
        {t.type === "abandoned_checkout" &&
          "Shopify only knows the email once they typed it at checkout. The cart and the link back to it go into the email ({{checkout_url}} and the product block set to “This person's cart or order”). "}
        {t.type === "order" && "Store sales count when the customer is on the sale (Rewards). The product block set to “This person's cart or order” shows what they bought online. "}
        {t.type === "signup" &&
          "People who sign up already get their welcome code by email at once (Email Popup). This flow is what comes after; it can use their welcome code ({{code}}, {{offer_amount}}, {{offer_ends}}). "}
        {t.type === "winback" && "Orders online and in the store both count. Each person enters once their last order passes this many days. "}
        {t.type === "shipped" && "Read from Shopify every 5 minutes: online orders marked shipped. {{tracking_url}} is their tracking link and {{order_name}} their order number. "}
                {t.type === "birthday" && "Birthdays come from Rewards (the store). Each person enters on their birthday, once a year; give the email step its own code as the gift. "}
        {locked ? "The trigger is fixed while the flow is on (set it back to draft to change it)." : "Changes save by themselves."}
      </p>
    </>
  );
}

function SettingsPanel({ s, onChange }: { s: FlowSettings; onChange: (s: FlowSettings) => void }) {
  return (
    <>
      <h3 className="text-sm font-semibold text-[var(--wms-fg)]">Flow settings</h3>
      <Row k="Who can get these emails">
        <select className={field} value={s.who} onChange={(e) => onChange({ ...s, who: e.target.value as FlowSettings["who"] })}>
          <option value="all">Everyone who has not unsubscribed</option>
          <option value="subscribed">Only people subscribed to marketing emails</option>
          <option value="transactional">About their own order (also to people who opted out of marketing)</option>
        </select>
      </Row>
      <Row k="Skip someone who got an email in the last (hours, 0 = never skip)">
        <input
          type="number"
          className={field}
          min={0}
          max={168}
          value={s.skipRecentHours}
          onChange={(e) =>
            onChange({
              ...s,
              skipRecentHours: Math.max(0, Math.min(168, Number(e.target.value) || 0)),
            })
          }
        />
      </Row>
      <div className="grid grid-cols-2 gap-2">
        <Row k="Send from (Orlando)">
          <select
            className={field}
            value={s.sendFrom}
            onChange={(e) =>
              onChange({
                ...s,
                sendFrom: Math.min(Number(e.target.value), s.sendTo - 1),
              })
            }
          >
            {Array.from({ length: 24 }, (_, h) => (
              <option key={h} value={h}>
                {hour(h)}
              </option>
            ))}
          </select>
        </Row>
        <Row k="Until">
          <select
            className={field}
            value={s.sendTo}
            onChange={(e) =>
              onChange({
                ...s,
                sendTo: Math.max(Number(e.target.value), s.sendFrom + 1),
              })
            }
          >
            {Array.from({ length: 24 }, (_, h) => h + 1).map((h) => (
              <option key={h} value={h}>
                {hour(h)}
              </option>
            ))}
          </select>
        </Row>
      </div>
      <Row k="Can the same person go through it again?">
        <select
          className={field}
          value={s.reentryDays == null ? "never" : String(s.reentryDays)}
          onChange={(e) =>
            onChange({
              ...s,
              reentryDays: e.target.value === "never" ? null : Number(e.target.value),
            })
          }
        >
          <option value="never">No, only once</option>
          {[1, 7, 14, 30, 60, 90, 180, 365].map((d) => (
            <option key={d} value={d}>
              Yes, after {d} day{d > 1 ? "s" : ""}
            </option>
          ))}
        </select>
      </Row>
      <p className="text-[0.72rem] leading-relaxed text-[var(--wms-muted)]">An email due outside the sending hours waits for the morning. Unsubscribed, bounced and complaining addresses never get anything.</p>
    </>
  );
}
const hour = (h: number) => (h === 0 || h === 24 ? "12 AM" : h === 12 ? "12 PM" : h < 12 ? `${h} AM` : `${h - 12} PM`);

function StepPanel(props: {
  step: FlowStep;
  flowId: string;
  emails: EmailRow[];
  onChange: (s: FlowStep) => void;
  onRemove: () => void;
  onMove: (d: -1 | 1) => void;
  onEdit: (designId: string) => void;
  onEmailsChanged: () => void;
  stats?: StepStats;
  trigger: Trigger;
}) {
  const { step: s, onChange } = props;
  const tools = (
    <div className="flex flex-wrap gap-1.5 border-t border-[var(--wms-border)] pt-2">
      <button type="button" className={`${btn} border-[var(--wms-border)]`} onClick={() => props.onMove(-1)}>
        Move up
      </button>
      <button type="button" className={`${btn} border-[var(--wms-border)]`} onClick={() => props.onMove(1)}>
        Move down
      </button>
      <button type="button" className={`${btn} ml-auto border-[var(--wms-border)] text-[var(--wms-status-danger-fg)]`} onClick={props.onRemove}>
        Remove step
      </button>
    </div>
  );
  if (s.type === "wait")
    return (
      <>
        <h3 className="text-sm font-semibold text-[var(--wms-fg)]">Time delay</h3>
        <div className="grid grid-cols-2 gap-2">
          <Row k="Wait">
            <input
              type="number"
              className={field}
              min={0}
              max={s.unit === "minutes" ? 1440 : s.unit === "hours" ? 720 : 365}
              value={s.amount}
              onChange={(e) =>
                onChange({
                  ...s,
                  amount: Math.max(0, Math.floor(Number(e.target.value) || 0)),
                })
              }
            />
          </Row>
          <Row k="Unit">
            <select className={field} value={s.unit} onChange={(e) => onChange({ ...s, unit: e.target.value as typeof s.unit })}>
              <option value="minutes">Minutes</option>
              <option value="hours">Hours</option>
              <option value="days">Days</option>
            </select>
          </Row>
        </div>
        <p className="text-[0.72rem] text-[var(--wms-muted)]">Then the next step. An email that falls at night waits for the sending hours (Settings).</p>
        {tools}
      </>
    );
  if (s.type === "stop")
    return (
      <>
        <h3 className="text-sm font-semibold text-[var(--wms-fg)]">Stop if…</h3>
        <Row k="The person leaves the flow here if">
          <select className={field} value={s.if} onChange={(e) => onChange({ ...s, if: e.target.value as typeof s.if })}>
            <option value="ordered">They placed an order since entering (online or in the store)</option>
            <option value="clicked">They clicked an email from this flow</option>
          </select>
        </Row>
        {tools}
      </>
    );
  return <EmailPanel {...props} step={s} tools={tools} />;
}

function EmailPanel({
  step: s,
  flowId,
  emails,
  onChange,
  onEdit,
  onEmailsChanged,
  stats,
  trigger,
  tools,
}: Parameters<typeof StepPanel>[0] & {
  step: EmailStep;
  tools: React.ReactNode;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [to, setTo] = useState("");
  const flowStarters = STARTERS.filter((x) => x.group === "flow");
  async function newFrom(starter: string) {
    setBusy("new");
    setMsg(null);
    try {
      const r = await send<{ id: string }>("/api/email/editor", "POST", {
        starter,
        title: `Flow · ${s.name}`,
      });
      onChange({ ...s, designId: r.id });
      onEmailsChanged();
      onEdit(r.id);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }
  async function test() {
    setBusy("test");
    setMsg(null);
    try {
      const r = await send<{ to: string }>(`/api/email/flows/${flowId}/action`, "POST", { action: "test", stepId: s.id, to: to.trim() || undefined });
      setMsg(`Test sent to ${r.to}.`);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }
  return (
    <>
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-[var(--wms-fg)]">Email</h3>
        <label className="flex items-center gap-1.5 text-xs text-[var(--wms-fg)]">
          <input type="checkbox" checked={s.live} onChange={(e) => onChange({ ...s, live: e.target.checked })} /> Sends (off = skipped)
        </label>
      </div>
      {stats && (stats.sent > 0 || stats.skipped > 0) && (
        <p className="font-mono text-[0.7rem] text-[var(--wms-muted)]">
          {stats.sent} sent · {stats.skipped} skipped · {pct(stats.opened, stats.sent)} opened · {pct(stats.clicked, stats.sent)} clicked · {stats.orders} orders · {money(stats.revenue)}
        </p>
      )}
      <Row k="Step name (only you see it)">
        <input className={field} maxLength={80} value={s.name} onChange={(e) => onChange({ ...s, name: e.target.value })} />
      </Row>
      <Row k="Subject line">
        <input className={field} maxLength={200} value={s.subject} placeholder="e.g. You left something behind" onChange={(e) => onChange({ ...s, subject: e.target.value })} />
      </Row>
      <Row k="Preview text">
        <input className={field} maxLength={300} value={s.preheader} onChange={(e) => onChange({ ...s, preheader: e.target.value })} />
      </Row>
      <Row k="The email">
        <select className={field} value={s.designId ?? ""} onChange={(e) => onChange({ ...s, designId: e.target.value || null })}>
          <option value="">Pick an email…</option>
          {emails.map((e) => (
            <option key={e.id} value={e.id}>
              {e.title}
            </option>
          ))}
        </select>
      </Row>
      <div className="flex flex-wrap gap-1.5">
        {s.designId && (
          <button type="button" className={`${btn} inline-flex items-center gap-1 border-[var(--wms-fg)] bg-[var(--wms-fg)] text-[var(--wms-bg)]`} onClick={() => onEdit(s.designId!)}>
            <Pencil size={12} /> Edit the email
          </button>
        )}
        <select className={field} value="" disabled={busy === "new"} onChange={(e) => e.target.value && void newFrom(e.target.value)} aria-label="New email from a starter">
          <option value="">{busy === "new" ? "Creating…" : "New email from a starter…"}</option>
          {flowStarters.map((x) => (
            <option key={x.id} value={x.id}>
              {x.name}
            </option>
          ))}
        </select>
      </div>
      <div className="flex flex-col gap-1.5 rounded-md border border-[var(--wms-border)] p-2">
        <label className="flex items-center gap-2 text-xs text-[var(--wms-fg)]">
          <input
            type="checkbox"
            checked={!!s.offer}
            onChange={(e) =>
              onChange({
                ...s,
                offer: e.target.checked ? { kind: "amount", amount: 20, days: 10, minSubtotal: 80 } : null,
              })
            }
          />{" "}
          Give each person their own Shopify code
        </label>
        {s.offer && (
          <div className="grid grid-cols-2 gap-2">
            <Row k="Amount">
              <input
                type="number"
                className={field}
                min={1}
                max={s.offer.kind === "percent" ? 90 : 500}
                value={s.offer.amount}
                onChange={(e) =>
                  onChange({
                    ...s,
                    offer: {
                      ...s.offer!,
                      amount: Math.max(1, Number(e.target.value) || 1),
                    },
                  })
                }
              />
            </Row>
            <Row k="Type">
              <select
                className={field}
                value={s.offer.kind}
                onChange={(e) =>
                  onChange({
                    ...s,
                    offer: {
                      ...s.offer!,
                      kind: e.target.value as "amount" | "percent",
                    },
                  })
                }
              >
                <option value="amount">$ off</option>
                <option value="percent">% off</option>
              </select>
            </Row>
            <Row k="Good for (days)">
              <input
                type="number"
                className={field}
                min={1}
                max={90}
                value={s.offer.days}
                onChange={(e) =>
                  onChange({
                    ...s,
                    offer: {
                      ...s.offer!,
                      days: Math.max(1, Math.min(90, Number(e.target.value) || 7)),
                    },
                  })
                }
              />
            </Row>
            <Row k="Minimum order ($, empty = none)">
              <input
                type="number"
                className={field}
                min={0}
                value={s.offer.minSubtotal ?? ""}
                onChange={(e) =>
                  onChange({
                    ...s,
                    offer: {
                      ...s.offer!,
                      minSubtotal: e.target.value ? Number(e.target.value) : null,
                    },
                  })
                }
              />
            </Row>
          </div>
        )}
        <p className="text-[0.7rem] text-[var(--wms-muted)]">
          {s.offer
            ? "One code per person, single use, made in Shopify when the email goes out. Put {{code}}, {{offer_amount}} and {{offer_ends}} in the email (the “Personal code offer” section does it)."
            : trigger.type === "signup"
              ? "Without a new code, {{code}} in this email is their welcome code from the sign-up."
              : "No code: the email has no discount."}
        </p>
      </div>
      <div className="flex gap-1.5">
        <input className={`${field} min-w-0 flex-1`} value={to} placeholder="Test to (empty = you)" onChange={(e) => setTo(e.target.value)} />
        <button type="button" className={`${btn} inline-flex items-center gap-1 border-[var(--wms-border)]`} disabled={!s.designId || busy === "test"} onClick={() => void test()}>
          {busy === "test" ? <Loader2 size={12} className="animate-spin" /> : <Send size={12} />} Send test
        </button>
      </div>
      {msg && <p className="text-xs text-[var(--wms-muted)]">{msg}</p>}
      {tools}
    </>
  );
}
