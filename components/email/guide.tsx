"use client";

import { useEffect, useRef } from "react";
import { BookOpen, Download, Sparkles, TriangleAlert, Lightbulb, X } from "lucide-react";
import { useUrlFlag } from "@/lib/use-url-param";
import { GUIDE, GUIDE_PDF_URL, type GuideBlock } from "@/lib/email-editor/guide";

/**
 * The Email Marketing guide (owner, 2026-11-10): a "Guide" button at the right of the tab row opens
 * the whole manual in a panel on the right, at the part for the tab you are on. The same text is the
 * PDF (scripts/gen-email-guide-pdf.ts → public/email/guide/). Open/closed lives in the URL (?guide=1).
 */
export function EmailGuideButton({ tab }: { tab: string }) {
  const [open, setOpen] = useUrlFlag("guide");
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mb-1 inline-flex shrink-0 items-center gap-1.5 rounded-md border border-[var(--wms-border)] px-3 py-1 font-mono text-[0.72rem] uppercase tracking-wide text-[var(--wms-fg)] hover:bg-[var(--wms-surface-elevated)] max-md:min-h-11"
        title="How to use Email Marketing: every tab, where the AI is, step by step"
      >
        <BookOpen className="h-3.5 w-3.5" aria-hidden />
        Guide
      </button>
      {open && <GuidePanel tab={tab} onClose={() => setOpen(false)} />}
    </>
  );
}

function GuidePanel({ tab, onClose }: { tab: string; onClose: () => void }) {
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const first = GUIDE.find((s) => s.tab === tab);
    if (first) body.current?.querySelector(`#guide-${first.id}`)?.scrollIntoView({ block: "start" });
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // Only when the panel opens: later tab clicks don't yank the reader away.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const jump = (id: string) => body.current?.querySelector(`#guide-${id}`)?.scrollIntoView({ block: "start", behavior: "smooth" });
  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-label="Email Marketing guide">
      <button type="button" aria-label="Close the guide" className="absolute inset-0 bg-black/40" onClick={onClose} />
      <aside className="relative flex h-full w-[min(620px,100vw)] flex-col border-l border-[var(--wms-border)] bg-[var(--wms-bg)] text-[var(--wms-fg)] shadow-2xl">
        <header className="flex items-center gap-2 border-b border-[var(--wms-border)] px-4 py-3">
          <BookOpen className="h-4 w-4 shrink-0" aria-hidden />
          <h2 className="min-w-0 flex-1 truncate text-base font-semibold">Email Marketing guide</h2>
          <a
            href={GUIDE_PDF_URL}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 rounded-md border border-[var(--wms-border)] px-2.5 py-1 font-mono text-[0.7rem] uppercase tracking-wide hover:bg-[var(--wms-surface-elevated)] max-md:min-h-11"
          >
            <Download className="h-3.5 w-3.5" aria-hidden />
            PDF
          </a>
          <button type="button" onClick={onClose} aria-label="Close" className="rounded-md p-1.5 hover:bg-[var(--wms-surface-elevated)] max-md:min-h-11 max-md:min-w-11">
            <X className="h-4 w-4" />
          </button>
        </header>
        <nav className="flex flex-wrap gap-1 border-b border-[var(--wms-border)] px-4 py-2" aria-label="Guide contents">
          {GUIDE.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => jump(s.id)}
              className={`rounded-full border px-2.5 py-0.5 text-[0.72rem] max-md:min-h-9 ${
                s.tab === tab ? "border-[var(--wms-fg)] text-[var(--wms-fg)]" : "border-[var(--wms-border)] text-[var(--wms-muted)] hover:text-[var(--wms-fg)]"
              }`}
            >
              {s.short ?? s.title}
            </button>
          ))}
        </nav>
        <div ref={body} className="min-h-0 flex-1 overflow-y-auto px-4 pb-16 pt-2 text-sm leading-relaxed">
          {GUIDE.map((s) => (
            <section key={s.id} id={`guide-${s.id}`} className="scroll-mt-2 border-b border-[var(--wms-border)] py-4 last:border-b-0">
              <h3 className="text-lg font-semibold">{s.title}</h3>
              {s.intro && <p className="mt-1 text-[var(--wms-muted)]">{rich(s.intro)}</p>}
              {s.parts.map((p, i) => (
                <div key={i} className="mt-4">
                  {p.title && <h4 className="mb-1.5 font-semibold">{p.title}</h4>}
                  <div className="flex flex-col gap-2">
                    {p.blocks.map((b, j) => (
                      <Block key={j} b={b} />
                    ))}
                  </div>
                </div>
              ))}
            </section>
          ))}
        </div>
      </aside>
    </div>
  );
}

function Block({ b }: { b: GuideBlock }) {
  switch (b.t) {
    case "p":
      return <p>{rich(b.text)}</p>;
    case "steps":
      return (
        <ol className="ml-5 list-decimal space-y-1">
          {b.items.map((x, i) => (
            <li key={i}>{rich(x)}</li>
          ))}
        </ol>
      );
    case "list":
      return (
        <ul className="ml-5 list-disc space-y-1">
          {b.items.map((x, i) => (
            <li key={i}>{rich(x)}</li>
          ))}
        </ul>
      );
    case "ai":
    case "tip":
    case "warn": {
      const Icon = b.t === "ai" ? Sparkles : b.t === "tip" ? Lightbulb : TriangleAlert;
      const tone =
        b.t === "ai"
          ? "border-violet-500/50 bg-violet-500/10"
          : b.t === "tip"
            ? "border-sky-500/50 bg-sky-500/10"
            : "border-amber-500/60 bg-amber-500/10";
      const label = b.t === "ai" ? "AI" : b.t === "tip" ? "Tip" : "Careful";
      return (
        <div className={`flex gap-2 rounded-md border px-3 py-2 ${tone}`}>
          <Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <p>
            <b>{label}: </b>
            {rich(b.text)}
          </p>
        </div>
      );
    }
    case "map":
      return (
        <figure className="my-1">
          {/* The guide's own drawing of the screen (lib/email-editor/guide.ts), not user content. */}
          <div className="rounded-md border border-[var(--wms-border)] p-1" dangerouslySetInnerHTML={{ __html: b.svg }} />
          <ol className="mt-2 space-y-1 text-[0.8rem]">
            {b.legend.map((x, i) => (
              <li key={i} className="flex gap-2">
                <span className="mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-rose-600 text-[0.62rem] font-bold text-white">{i + 1}</span>
                <span>{rich(x)}</span>
              </li>
            ))}
          </ol>
        </figure>
      );
    case "table":
      return (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-[0.8rem]">
            <thead>
              <tr>
                {b.head.map((h, i) => (
                  <th key={i} className="border-b border-[var(--wms-border)] px-2 py-1 text-left font-semibold">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {b.rows.map((r, i) => (
                <tr key={i}>
                  {r.map((c, k) => (
                    <td key={k} className="border-b border-[var(--wms-border)] px-2 py-1 align-top">
                      {rich(c)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
  }
}

/** **bold** inside guide text. */
function rich(s: string) {
  return s.split(/\*\*(.+?)\*\*/g).map((x, i) => (i % 2 ? <b key={i}>{x}</b> : x));
}
