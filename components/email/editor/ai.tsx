"use client";
/**
 * CarbonWMS Email Editor — the AI buttons (phase 3; text only, never pictures).
 *   AiRewrite   — in a text block's panel: shorter / bolder / warmer / fix spelling / your own ask → 3 options.
 *   AiSubjects  — in "Subject line and preview text": 6 ideas, click one to use it.
 *   AiCheck     — the "Check" sheet: what to fix before sending; click a problem to go to its block.
 *   AiWrite     — on New email: "Write it with AI" from a sentence or two.
 * Every change goes through the editor's normal undo (Ctrl+Z).
 */
import { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, Lightbulb, Loader2, Sparkles } from "lucide-react";
import type { EmailDoc } from "@/lib/email-editor/types";
import { chipTags } from "@/lib/email-editor/render";
import { Group, inputCls } from "./fields";
import { Modal, ghostBtn, primaryBtn } from "./pickers";

async function ai<T>(body: Record<string, unknown>): Promise<T> {
  const r = await fetch("/api/email/editor/ai", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const j = (await r.json().catch(() => ({}))) as T & { error?: string };
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}

const chip = "h-7 rounded border border-[var(--wms-border)] px-2.5 text-[0.75rem] text-[var(--wms-fg)] hover:border-[var(--wms-fg)] disabled:opacity-50";
const errCls = "text-[0.72rem] text-[var(--wms-status-danger-fg)]";

/** The words of a whole email (context for a rewrite). */
export function docWords(doc: EmailDoc): string {
  const out: string[] = [];
  for (const s of doc.sections)
    for (const c of s.cols)
      for (const b of c.blocks) {
        if (b.type === "text") out.push(b.html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
        else if (b.type === "button") out.push(`[button] ${b.text}`);
      }
  return out.filter(Boolean).join("\n").slice(0, 5000);
}

type How = "shorter" | "longer" | "bolder" | "warmer" | "fix" | "custom";
const HOWS: [How, string][] = [
  ["shorter", "Shorter"],
  ["bolder", "Bolder"],
  ["warmer", "Warmer"],
  ["longer", "A bit longer"],
  ["fix", "Fix spelling"],
];

export function AiRewrite({ html, context, onUse }: { html: string; context: () => string; onUse: (html: string) => void }) {
  const [busy, setBusy] = useState<How | null>(null);
  const [own, setOwn] = useState("");
  const [opts, setOpts] = useState<string[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const run = async (how: How) => {
    setBusy(how);
    setErr(null);
    setOpts(null);
    try {
      const j = await ai<{ options: string[] }>({ action: "rewrite", html, how, instruction: how === "custom" ? own : undefined, context: context() });
      setOpts(j.options);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };
  return (
    <Group title="Rewrite with AI">
      <div className="flex flex-wrap gap-1.5">
        {HOWS.map(([k, label]) => (
          <button key={k} type="button" className={chip} disabled={!!busy} onClick={() => void run(k)}>
            {busy === k ? <Loader2 size={12} className="inline animate-spin" /> : label}
          </button>
        ))}
      </div>
      <div className="flex gap-1.5">
        <input className={inputCls} value={own} maxLength={500} placeholder="Or say how: e.g. mention the weekend" onChange={(e) => setOwn(e.target.value)} onKeyDown={(e) => e.key === "Enter" && own.trim() && void run("custom")} />
        <button type="button" className={`${chip} h-8 shrink-0`} disabled={!!busy || !own.trim()} onClick={() => void run("custom")}>
          {busy === "custom" ? <Loader2 size={12} className="inline animate-spin" /> : "Go"}
        </button>
      </div>
      {err && <p className={errCls}>{err}</p>}
      {opts && (
        <div className="flex flex-col gap-2">
          <p className="text-[0.7rem] text-[var(--wms-muted)]">Click one to use it. Ctrl+Z brings the old words back.</p>
          {opts.map((o, i) => (
            <button
              key={i}
              type="button"
              onClick={() => {
                onUse(o);
                setOpts(null);
              }}
              className="rounded border border-[var(--wms-border)] bg-white p-2.5 text-left text-[0.8rem] leading-snug text-[#1f2328] hover:border-[var(--wms-accent)] [&_h1]:text-[1.05rem] [&_h1]:font-bold [&_h2]:text-[1rem] [&_h2]:font-bold [&_h3]:font-bold [&_p]:my-0.5"
              dangerouslySetInnerHTML={{ __html: chipTags(o) }}
            />
          ))}
        </div>
      )}
    </Group>
  );
}

export function AiSubjects({ doc, onUse }: { doc: EmailDoc; onUse: (subject: string, preheader: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [hint, setHint] = useState("");
  const [ideas, setIdeas] = useState<{ subject: string; preheader: string }[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const run = async () => {
    setBusy(true);
    setErr(null);
    try {
      setIdeas((await ai<{ ideas: { subject: string; preheader: string }[] }>({ action: "subjects", doc, hint: hint.trim() || undefined })).ideas);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Group title="Ideas from AI">
      <input className={inputCls} value={hint} maxLength={500} placeholder="Optional: e.g. playful, mention the store" onChange={(e) => setHint(e.target.value)} />
      <button type="button" className={`${primaryBtn} inline-flex items-center justify-center gap-1.5`} disabled={busy} onClick={() => void run()}>
        {busy ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />} {ideas ? "More ideas" : "Suggest subject lines"}
      </button>
      {err && <p className={errCls}>{err}</p>}
      {ideas?.map((x, i) => (
        <button key={i} type="button" onClick={() => onUse(x.subject, x.preheader)} className="rounded border border-[var(--wms-border)] p-2.5 text-left hover:border-[var(--wms-accent)]">
          <span className="block text-[0.8rem] font-semibold text-[var(--wms-fg)]">{x.subject}</span>
          <span className="block text-[0.74rem] text-[var(--wms-muted)]">{x.preheader}</span>
        </button>
      ))}
      {ideas && <p className="text-[0.7rem] text-[var(--wms-muted)]">Click one to use it (you can still edit it above).</p>}
    </Group>
  );
}

type Issue = { level: "fix" | "tip"; blockId: string | null; text: string };

export function AiCheck({ doc, subject, preheader, onClose, onGo }: { doc: EmailDoc; subject: string; preheader: string; onClose: () => void; onGo: (blockId: string | null) => void }) {
  const [state, setState] = useState<{ busy: boolean; issues: Issue[] | null; err: string | null }>({ busy: false, issues: null, err: null });
  const run = async () => {
    setState({ busy: true, issues: null, err: null });
    try {
      setState({ busy: false, issues: (await ai<{ issues: Issue[] }>({ action: "check", doc, subject, preheader })).issues, err: null });
    } catch (e) {
      setState({ busy: false, issues: null, err: e instanceof Error ? e.message : String(e) });
    }
  };
  useEffect(() => {
    void run(); // checks the email as it is when the sheet opens
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const fixes = state.issues?.filter((x) => x.level === "fix") ?? [];
  const tips = state.issues?.filter((x) => x.level === "tip") ?? [];
  const row = (x: Issue, i: number) => (
    <button
      key={i}
      type="button"
      onClick={() => onGo(x.blockId)}
      className="flex w-full items-start gap-2 rounded border border-[var(--wms-border)] p-2.5 text-left text-[0.8rem] text-[var(--wms-fg)] hover:border-[var(--wms-fg)]"
    >
      {x.level === "fix" ? <AlertTriangle size={15} className="mt-0.5 shrink-0 text-[var(--wms-status-danger-fg)]" /> : <Lightbulb size={15} className="mt-0.5 shrink-0 text-[var(--wms-muted)]" />}
      <span>
        {x.text}
        <span className="block text-[0.7rem] text-[var(--wms-muted)]">{x.blockId ? "Click to go to it" : "Subject line, preview text or the whole email"}</span>
      </span>
    </button>
  );
  return (
    <Modal
      title="Check before sending"
      onClose={onClose}
      footer={
        <>
          <button type="button" className={ghostBtn} disabled={state.busy} onClick={() => void run()}>
            Check again
          </button>
          <button type="button" className={primaryBtn} onClick={onClose}>
            Done
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-2 p-4">
        {state.busy && (
          <p className="inline-flex items-center gap-2 text-[0.82rem] text-[var(--wms-muted)]">
            <Loader2 size={15} className="animate-spin" /> Reading every block, link and picture…
          </p>
        )}
        {state.err && <p className={errCls}>{state.err}</p>}
        {state.issues && !state.issues.length && (
          <p className="inline-flex items-center gap-2 text-[0.85rem] text-[var(--wms-fg)]">
            <CheckCircle2 size={16} className="text-[var(--wms-accent)]" /> Nothing to fix. The words, links, pictures and personal tags look right.
          </p>
        )}
        {!!fixes.length && <h4 className="text-[0.8rem] font-semibold text-[var(--wms-fg)]">Fix before sending ({fixes.length})</h4>}
        {fixes.map(row)}
        {!!tips.length && <h4 className="mt-2 text-[0.8rem] font-semibold text-[var(--wms-fg)]">Worth a look ({tips.length})</h4>}
        {tips.map(row)}
        <p className="mt-2 text-[0.7rem] text-[var(--wms-muted)]">Links, pictures and personal tags are checked by fixed rules; the words are read by AI (text only, a few cents).</p>
      </div>
    </Modal>
  );
}

export function AiWrite({ onCreated }: { onCreated: (id: string) => void }) {
  const [brief, setBrief] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const run = async () => {
    setBusy(true);
    setErr(null);
    try {
      onCreated((await ai<{ id: string }>({ action: "build", brief })).id);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-col gap-2 rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] p-3">
      <h3 className="inline-flex items-center gap-1.5 text-sm font-semibold text-[var(--wms-fg)]">
        <Sparkles size={15} /> Write it with AI
      </h3>
      <p className="text-xs text-[var(--wms-muted)]">Say what the email is about. The AI picks the sections, writes the words and chooses your in-stock products and their photos. Everything stays editable. Text only: it never draws pictures.</p>
      <textarea
        className={`${inputCls} min-h-[70px] py-2`}
        value={brief}
        maxLength={2000}
        placeholder="e.g. Women's going-out looks for the weekend, dark and bold, give them their code, invite them to the store"
        onChange={(e) => setBrief(e.target.value)}
      />
      <div className="flex items-center gap-2">
        <button type="button" className={`${primaryBtn} inline-flex items-center gap-1.5`} disabled={busy || brief.trim().length < 6} onClick={() => void run()}>
          {busy ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />} {busy ? "Writing… (about a minute)" : "Write it"}
        </button>
        {err && <p className={errCls}>{err}</p>}
      </div>
    </div>
  );
}
