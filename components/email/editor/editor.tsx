"use client";

/**
 * CarbonWMS Email Editor (owner, 2026-11-09: "copy the layout and the email module of Klaviyo").
 * Full screen, laid out like Klaviyo's editor:
 *   top bar  — back, the email's name, autosave tick, Version history, Preview, Done
 *   left     — a rail (Add content · Edit styles · Inbox) and a 335 px panel; selecting a block or
 *              a section shows its settings there
 *   middle   — the canvas, with a floating Undo · Redo · Desktop · Mobile bar
 *   right    — version history (on demand)
 * Every change autosaves (about a second later); a version is kept when you leave.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlignCenter,
  AlignJustify,
  AlignLeft,
  AlignRight,
  ArrowLeft,
  Bold,
  BookmarkPlus,
  Check,
  ChevronLeft,
  CircleAlert,
  Eraser,
  History,
  Italic,
  Link2,
  List,
  ListChecks,
  ListOrdered,
  Loader2,
  Mail,
  Monitor,
  Palette,
  Plus,
  Redo2,
  Smartphone,
  Strikethrough,
  Underline,
  Undo2,
  UserRound,
} from "lucide-react";
import { BLOCK_LABEL, cloneSection, docColors, newBlock, type Block, type BlockType, type BrandKit, type EmailDoc, type ProductFeed, type ProductItem } from "@/lib/email-editor/types";
import { prebuiltSections } from "@/lib/email-editor/prebuilt";
import { Canvas, isSectionDrag, type Drag, type Drop } from "./canvas";
import { AddContentPanel, BlockPanel, SectionPanel, StylesPanel, type KitState, type PanelHelpers, type SavedSection } from "./panels";
import { ImagePicker, LayoutDialog, Modal, ProductPicker, ghostBtn, primaryBtn, type PickedImage } from "./pickers";
import { PreviewSheet, VersionsPanel } from "./preview";
import { AiCheck, AiSubjects, docWords } from "./ai";
import { BrandColors, Field, FontPicker, Group, Text, inputCls, useEditorFonts } from "./fields";
import {
  addNewBlock,
  addSection,
  duplicateBlock,
  duplicateSection,
  findBlock,
  findSection,
  insertBlock,
  insertSections,
  moveBlock,
  moveSection,
  removeBlock,
  removeSection,
  setLayout,
  updateBlock,
  updateSection,
  useHistory,
  type Sel,
  type Spot,
} from "./state";

type Loaded = { id: string; title: string; doc: EmailDoc; subject: string; preheader: string; translate_status: string | null; has_es: boolean; has_pt: boolean; updated_at: string };
type CatalogItem = ProductItem & { gender: string; type: string; stock: number };

/* -------------------------------------------------------------- text bar */

function BarBtn({ title, onClick, children, keep }: { title: string; onClick: () => void; children: React.ReactNode; keep: () => void }) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onMouseDown={(e) => {
        e.preventDefault();
        keep();
      }}
      onClick={onClick}
      className="grid h-8 w-8 place-items-center rounded text-[#2b2f36] hover:bg-[#EEF1F6]"
    >
      {children}
    </button>
  );
}

function TextBar() {
  const saved = useRef<Range | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [tags, setTags] = useState(false);
  const [fallback, setFallback] = useState("there");
  const keep = () => {
    const s = window.getSelection();
    if (s && s.rangeCount) saved.current = s.getRangeAt(0).cloneRange();
  };
  const restore = () => {
    const ed = document.querySelector<HTMLElement>("[data-ce-editable]");
    ed?.focus();
    if (saved.current) {
      const s = window.getSelection();
      s?.removeAllRanges();
      s?.addRange(saved.current);
    }
  };
  const cmd = (c: string, v?: string) => {
    restore();
    document.execCommand(c, false, v);
    keep();
  };
  /** Size for the selected words: the browser marks them, then the mark becomes an exact px size. */
  const size = (px: number) => {
    restore();
    document.execCommand("fontSize", false, "7");
    const ed = document.querySelector<HTMLElement>("[data-ce-editable]");
    if (!ed) return;
    ed.querySelectorAll<HTMLElement>('font[size="7"], span[style*="xxx-large"]').forEach((el) => {
      el.removeAttribute("size");
      el.style.fontSize = `${px}px`;
    });
    ed.dispatchEvent(new Event("input", { bubbles: true }));
    keep();
  };
  const [font, setFont] = useState("Helvetica");
  const insertTag = (t: string) => {
    restore();
    document.execCommand("insertText", false, t);
    setTags(false);
  };
  return (
    <div
      className="sticky top-3 z-40 mx-auto flex w-fit max-w-[calc(100%-24px)] flex-wrap items-center gap-0.5 rounded-lg border border-[#E3E6EC] bg-white px-1.5 py-1 shadow-lg"
      onMouseDown={(e) => {
        if ((e.target as HTMLElement).tagName !== "INPUT" && (e.target as HTMLElement).tagName !== "SELECT") e.preventDefault();
      }}
    >
      <select
        aria-label="Paragraph style"
        className="h-8 rounded border border-[#E3E6EC] bg-white px-1.5 text-[12px] text-[#2b2f36]"
        onMouseDown={keep}
        onChange={(e) => {
          cmd("formatBlock", e.target.value);
          e.target.value = "";
        }}
        defaultValue=""
      >
        <option value="" disabled>
          Style
        </option>
        <option value="H1">Heading 1</option>
        <option value="H2">Heading 2</option>
        <option value="H3">Heading 3</option>
        <option value="H4">Heading 4</option>
        <option value="P">Body</option>
      </select>
      <div onMouseDown={keep}>
        <FontPicker
          compact
          value={font}
          onChange={(name) => {
            setFont(name);
            cmd("fontName", name);
            document.querySelector<HTMLElement>("[data-ce-editable]")?.dispatchEvent(new Event("input", { bubbles: true }));
          }}
        />
      </div>
      <select
        aria-label="Text size"
        className="h-8 rounded border border-[#E3E6EC] bg-white px-1 text-[12px] text-[#2b2f36]"
        onMouseDown={keep}
        defaultValue=""
        onChange={(e) => {
          size(Number(e.target.value));
          e.target.value = "";
        }}
      >
        <option value="" disabled>
          Size
        </option>
        {[11, 12, 13, 14, 16, 18, 20, 24, 28, 32, 36, 42, 48, 56, 64, 72, 88, 104].map((n) => (
          <option key={n} value={n}>
            {n}px
          </option>
        ))}
      </select>
      <BarBtn keep={keep} title="Bold" onClick={() => cmd("bold")}>
        <Bold size={15} />
      </BarBtn>
      <BarBtn keep={keep} title="Italic" onClick={() => cmd("italic")}>
        <Italic size={15} />
      </BarBtn>
      <BarBtn keep={keep} title="Underline" onClick={() => cmd("underline")}>
        <Underline size={15} />
      </BarBtn>
      <BarBtn keep={keep} title="Strikethrough" onClick={() => cmd("strikeThrough")}>
        <Strikethrough size={15} />
      </BarBtn>
      <label className="grid h-8 w-8 cursor-pointer place-items-center rounded hover:bg-[#EEF1F6]" title="Text color" onMouseDown={keep}>
        <span className="h-4 w-4 rounded-sm border border-[#c9ced8]" style={{ background: "conic-gradient(#e53935,#fbc02d,#43a047,#1e88e5,#8e24aa,#e53935)" }} />
        <input type="color" className="sr-only" aria-label="Text color" onChange={(e) => cmd("foreColor", e.target.value)} />
      </label>
      <span className="mx-0.5 h-5 w-px bg-[#E3E6EC]" />
      <BarBtn keep={keep} title="Align left" onClick={() => cmd("justifyLeft")}>
        <AlignLeft size={15} />
      </BarBtn>
      <BarBtn keep={keep} title="Align center" onClick={() => cmd("justifyCenter")}>
        <AlignCenter size={15} />
      </BarBtn>
      <BarBtn keep={keep} title="Align right" onClick={() => cmd("justifyRight")}>
        <AlignRight size={15} />
      </BarBtn>
      <BarBtn keep={keep} title="Justify" onClick={() => cmd("justifyFull")}>
        <AlignJustify size={15} />
      </BarBtn>
      <BarBtn keep={keep} title="Bulleted list" onClick={() => cmd("insertUnorderedList")}>
        <List size={15} />
      </BarBtn>
      <BarBtn keep={keep} title="Numbered list" onClick={() => cmd("insertOrderedList")}>
        <ListOrdered size={15} />
      </BarBtn>
      <span className="mx-0.5 h-5 w-px bg-[#E3E6EC]" />
      <div className="relative">
        <BarBtn keep={keep} title="Link" onClick={() => setLink(link == null ? "https://shopcarbon.com/" : null)}>
          <Link2 size={15} />
        </BarBtn>
        {link != null && (
          <div className="absolute left-0 top-10 z-50 flex w-72 flex-col gap-2 rounded-md border border-[#E3E6EC] bg-white p-3 shadow-lg">
            <input className="h-8 rounded border border-[#d5d9e0] px-2 text-[12px] text-[#2b2f36]" value={link} onChange={(e) => setLink(e.target.value)} aria-label="Link address" autoFocus />
            <div className="flex gap-2">
              <button
                type="button"
                className="h-7 rounded bg-[#2F6FED] px-3 text-[12px] font-semibold text-white"
                onClick={() => {
                  cmd("createLink", link.trim());
                  setLink(null);
                }}
              >
                Apply
              </button>
              <button
                type="button"
                className="h-7 rounded border border-[#d5d9e0] px-3 text-[12px] text-[#2b2f36]"
                onClick={() => {
                  cmd("unlink");
                  setLink(null);
                }}
              >
                Remove link
              </button>
            </div>
          </div>
        )}
      </div>
      <div className="relative">
        <BarBtn keep={keep} title="Personal tags (first name, code …)" onClick={() => setTags(!tags)}>
          <UserRound size={15} />
        </BarBtn>
        {tags && (
          <div className="absolute right-0 top-10 z-50 flex w-64 flex-col gap-1 rounded-md border border-[#E3E6EC] bg-white p-2 text-[12px] text-[#2b2f36] shadow-lg">
            <div className="flex flex-col gap-1 rounded border border-[#eef0f4] p-2">
              <span className="font-semibold">First name</span>
              <label className="text-[11px] text-[#6b7280]" htmlFor="ce-fallback">
                When we don&apos;t know the name, show
              </label>
              <input id="ce-fallback" className="h-7 rounded border border-[#d5d9e0] px-2" value={fallback} onChange={(e) => setFallback(e.target.value)} />
              <button type="button" className="h-7 rounded bg-[#2F6FED] text-[12px] font-semibold text-white" onClick={() => insertTag(`{{first_name|${fallback.replace(/[{}|]/g, "")}}}`)}>
                Insert first name
              </button>
            </div>
            {(
              [
                ["{{code}}", "The person's code"],
                ["{{offer_amount}}", "The offer ($20 / 10%)"],
                ["{{offer_ends}}", "The code's end date"],
                ["{{shop_url}}", "Shop link"],
              ] as const
            ).map(([t, l]) => (
              <button key={t} type="button" className="rounded px-2 py-1.5 text-left hover:bg-[#EEF1F6]" onClick={() => insertTag(t)}>
                {l}
              </button>
            ))}
          </div>
        )}
      </div>
      <BarBtn keep={keep} title="Clear formatting" onClick={() => cmd("removeFormat")}>
        <Eraser size={15} />
      </BarBtn>
    </div>
  );
}

/* ---------------------------------------------------------------- editor */

export function EmailEditor({ id, onClose }: { id: string; onClose: () => void }) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  useEffect(() => {
    let off = false;
    fetch(`/api/email/editor/${id}`, { cache: "no-store" })
      .then(async (r) => {
        const j = (await r.json()) as { email?: Loaded; error?: string };
        if (!r.ok || !j.email) throw new Error(j.error || `HTTP ${r.status}`);
        if (!off) setLoaded(j.email);
      })
      .catch((e) => !off && setLoadErr(e instanceof Error ? e.message : String(e)));
    return () => {
      off = true;
    };
  }, [id]);
  if (loadErr)
    return (
      <div className="fixed inset-0 z-[60] grid place-items-center bg-[var(--wms-bg)] p-6 text-center">
        <div className="flex flex-col items-center gap-3">
          <p className="text-[0.9rem] text-[var(--wms-status-danger-fg)]">Could not open this email: {loadErr}</p>
          <button type="button" className="h-8 rounded border border-[var(--wms-border)] px-3 text-[0.8rem] text-[var(--wms-fg)]" onClick={onClose}>
            Back to emails
          </button>
        </div>
      </div>
    );
  if (!loaded)
    return (
      <div className="fixed inset-0 z-[60] grid place-items-center bg-[var(--wms-bg)]">
        <Loader2 className="animate-spin text-[var(--wms-muted)]" />
      </div>
    );
  return <EditorInner initial={loaded} onClose={onClose} />;
}

function EditorInner({ initial, onClose }: { initial: Loaded; onClose: () => void }) {
  useEditorFonts();
  /* phase 2: saved sections + brand kit (loaded once; changed here) */
  const [saved, setSaved] = useState<SavedSection[] | null>(null);
  const [kit, setKit] = useState<KitState>({ kit: null, busy: false, msg: null });
  const [naming, setNaming] = useState<{ kind: "template" | "section"; sectionId?: string; name: string; busy?: boolean; err?: string } | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const loadSaved = useCallback(async () => {
    const r = await fetch("/api/email/editor/library", { cache: "no-store" }).catch(() => null);
    if (!r?.ok) return setSaved([]);
    const j = (await r.json()) as { sections: SavedSection[] };
    setSaved(j.sections);
  }, []);
  useEffect(() => {
    void loadSaved();
    void fetch("/api/email/editor/brand-kit", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : { kit: null }))
      .then((j: { kit: BrandKit | null }) => setKit((k) => ({ ...k, kit: j.kit })))
      .catch(() => {});
  }, [loadSaved]);
  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(null), 3500);
    return () => clearTimeout(t);
  }, [flash]);
  const h = useHistory(initial.doc);
  const { doc } = h;
  const [title, setTitle] = useState(initial.title);
  const [subject, setSubject] = useState(initial.subject);
  const [preheader, setPreheader] = useState(initial.preheader);
  const [mobile, setMobile] = useState(false);
  const [sel, setSel] = useState<Sel>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [drag, setDragState] = useState<Drag>(null);
  const [drop, setDropState] = useState<Drop>(null);
  // The drop event can arrive before React has drawn the last drag-over: read the live values.
  const dragRef = useRef<Drag>(null);
  const dropRef = useRef<Drop>(null);
  const setDrag = useCallback((d: Drag) => {
    dragRef.current = d;
    setDragState(d);
  }, []);
  const setDrop = useCallback((d: Drop) => {
    dropRef.current = d;
    setDropState(d);
  }, []);
  const [rail, setRail] = useState<"add" | "styles" | "inbox">("add");
  const [collapsed, setCollapsed] = useState(false);
  const [versions, setVersions] = useState(false);
  const [preview, setPreview] = useState(false);
  const [save, setSave] = useState<{ state: "saved" | "saving" | "error"; at: string; err?: string }>({ state: "saved", at: initial.updated_at });
  const [lang, setLang] = useState({ status: initial.translate_status, es: initial.has_es, pt: initial.has_pt });
  const [imgCb, setImgCb] = useState<((i: PickedImage) => void) | null>(null);
  const [prodCb, setProdCb] = useState<{ initial: ProductItem[]; cb: (items: ProductItem[]) => void } | null>(null);
  const [layoutAt, setLayoutAt] = useState<number | null>(null);

  /* catalog for dynamic product blocks (loaded once) */
  const catalog = useRef<Promise<CatalogItem[]> | null>(null);
  const getCatalog = useCallback(() => {
    catalog.current ??= fetch("/api/email/editor/catalog", { cache: "no-store" })
      .then((r) => r.json())
      .then((j: { products?: CatalogItem[] }) => j.products ?? [])
      .catch(() => []);
    return catalog.current;
  }, []);
  const feedItems = useCallback(
    async (feed: ProductFeed): Promise<ProductItem[]> => {
      const all = await getCatalog();
      let list = all;
      if (feed === "women" || feed === "men") list = all.filter((p) => p.gender === feed || p.gender === "unisex");
      if (feed === "most-stock") list = [...all].sort((a, b) => b.stock - a.stock);
      return list.slice(0, 60).map((p) => ({ id: p.id, title: p.title, price: p.price, compareAt: p.compareAt, image: p.image, url: p.url, set: null }));
    },
    [getCatalog],
  );
  // Dynamic product blocks show today's products when the email is opened.
  const refreshed = useRef(false);
  useEffect(() => {
    if (refreshed.current) return;
    refreshed.current = true;
    const dyn = initial.doc.sections.flatMap((s) => s.cols.flatMap((c) => c.blocks)).filter((b) => b.type === "product" && b.source === "dynamic");
    if (!dyn.length) return;
    (async () => {
      for (const b of dyn) {
        if (b.type !== "product") continue;
        const items = await feedItems(b.feed);
        // Onto the CURRENT email (the owner may already be typing), no undo step.
        h.patch((cur) => updateBlock(cur, b.id, (x) => (x.type === "product" && x.source === "dynamic" ? { ...x, items } : x)));
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* autosave */
  const first = useRef(true);
  const latest = useRef({ doc, title, subject, preheader });
  latest.current = { doc, title, subject, preheader };
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dirty = useRef(false);
  const saveNow = useCallback(
    async (snapshot = false) => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      setSave((s) => ({ ...s, state: "saving" }));
      try {
        const r = await fetch(`/api/email/editor/${initial.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...latest.current, title: latest.current.title.trim() || "Untitled email", snapshot }),
        });
        const j = (await r.json()) as { updated_at?: string; translationsDropped?: boolean; error?: string };
        if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
        dirty.current = false;
        setSave({ state: "saved", at: j.updated_at ?? new Date().toISOString() });
        if (j.translationsDropped) setLang({ status: null, es: false, pt: false });
        return j.updated_at ?? "";
      } catch (e) {
        setSave((s) => ({ ...s, state: "error", err: e instanceof Error ? e.message : String(e) }));
        throw e;
      }
    },
    [initial.id],
  );
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    dirty.current = true;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void saveNow().catch(() => {}), 1100);
  }, [doc, title, subject, preheader, saveNow]);
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (dirty.current) e.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, []);
  const exit = async () => {
    try {
      await saveNow(true);
      onClose();
    } catch {
      /* the error shows in the top bar; stay */
    }
  };

  /* selection helpers */
  const selBlock = sel?.kind === "block" ? findBlock(doc, sel.id)?.block ?? null : null;
  const selSectionIdx = sel?.kind === "section" ? findSection(doc, sel.id) : -1;
  const selSection = selSectionIdx >= 0 ? doc.sections[selSectionIdx] : null;
  useEffect(() => {
    if (sel?.kind === "block" && !findBlock(doc, sel.id)) setSel(null);
    if (sel?.kind === "section" && findSection(doc, sel.id) < 0) setSel(null);
  }, [doc, sel]);

  /** Where a clicked tile goes: under the selected block, else at the end of the selected / last section. */
  const addSpot = (): Spot | null => {
    if (sel?.kind === "block") {
      const f = findBlock(doc, sel.id);
      if (f) return { section: doc.sections[f.s].id, col: f.c, index: f.i + 1 };
    }
    const s = selSection ?? doc.sections[doc.sections.length - 1];
    if (!s) return null;
    return { section: s.id, col: 0, index: s.cols[0].blocks.length };
  };
  const afterSection = () => (selSectionIdx >= 0 ? selSectionIdx + 1 : sel?.kind === "block" ? (findBlock(doc, sel.id)?.s ?? doc.sections.length - 1) + 1 : doc.sections.length);

  const addBlock = (t: BlockType) => {
    let spot = addSpot();
    let d = doc;
    if (!spot) {
      const r = addSection(d, 0, [100]);
      d = r.doc;
      spot = { section: r.id, col: 0, index: 0 };
    }
    const b = newBlock(t);
    h.set(insertBlock(d, spot, b));
    setSel({ kind: "block", id: b.id });
    if (b.type === "product" && b.source === "dynamic") void feedItems(b.feed).then((items) => h.set((cur) => updateBlock(cur, b.id, (x) => (x.type === "product" ? { ...x, items } : x)), `feed${b.id}`));
  };
  const addPrebuilt = (pid: string, at = afterSection()) => {
    const secs = prebuiltSections(pid);
    if (!secs.length) return;
    h.set(insertSections(doc, at, secs));
    setSel({ kind: "section", id: secs[0].id });
    for (const s of secs)
      for (const c of s.cols)
        for (const b of c.blocks)
          if (b.type === "product" && b.source === "dynamic") void feedItems(b.feed).then((items) => h.set((cur) => updateBlock(cur, b.id, (x) => (x.type === "product" ? { ...x, items } : x)), `feed${b.id}`));
  };

  const addSaved = (sid: string, at = afterSection()) => {
    const x = saved?.find((y) => y.id === sid);
    if (!x) return;
    const sec = cloneSection(x.data);
    h.set(insertSections(doc, at, [sec]));
    setSel({ kind: "section", id: sec.id });
  };
  const deleteSaved = async (sid: string, name: string) => {
    if (!window.confirm(`Delete the saved section “${name}”? Emails that already use it keep their copy.`)) return;
    await fetch(`/api/email/editor/library?id=${sid}`, { method: "DELETE" }).catch(() => null);
    void loadSaved();
  };
  const saveNamed = async () => {
    if (!naming) return;
    const name = naming.name.trim();
    if (!name) return setNaming({ ...naming, err: "Give it a name" });
    const data = naming.kind === "template" ? doc : doc.sections.find((x) => x.id === naming.sectionId);
    if (!data) return setNaming(null);
    setNaming({ ...naming, busy: true, err: undefined });
    const r = await fetch("/api/email/editor/library", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind: naming.kind, name, data }) }).catch(() => null);
    const j = r ? ((await r.json().catch(() => ({}))) as { error?: string }) : { error: "No connection" };
    if (!r?.ok) return setNaming({ ...naming, busy: false, err: j.error || "Could not save" });
    setNaming(null);
    if (naming.kind === "section") {
      void loadSaved();
      setFlash(`Saved “${name}”. Find it in Add content → Saved.`);
    } else setFlash(`Saved “${name}” as a template. Find it under New email.`);
  };
  const putKit = async (next: BrandKit, msg: string) => {
    setKit((k) => ({ ...k, busy: true, msg: null }));
    const r = await fetch("/api/email/editor/brand-kit", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(next) }).catch(() => null);
    const j = r ? ((await r.json().catch(() => ({}))) as { error?: string }) : { error: "No connection" };
    setKit((k) => (r?.ok ? { kit: next, busy: false, msg } : { ...k, busy: false, msg: j.error || "Could not save the brand kit" }));
  };

  const onDrop = () => {
    const g = dragRef.current;
    const d = dropRef.current;
    setDrag(null);
    setDrop(null);
    if (!g || !d) return;
    if (d.kind === "block" && g.kind === "new") {
      const r = addNewBlock(doc, d.spot, g.type);
      h.set(r.doc);
      setSel({ kind: "block", id: r.id });
      const nb = findBlock(r.doc, r.id)?.block;
      if (nb?.type === "product" && nb.source === "dynamic") void feedItems(nb.feed).then((items) => h.set((cur) => updateBlock(cur, r.id, (x) => (x.type === "product" ? { ...x, items } : x)), `feed${r.id}`));
    } else if (d.kind === "block" && g.kind === "move") {
      h.set(moveBlock(doc, g.id, d.spot));
      setSel({ kind: "block", id: g.id });
    } else if (d.kind === "section" && g.kind === "prebuilt") addPrebuilt(g.id, d.at);
    else if (d.kind === "section" && g.kind === "saved") addSaved(g.id, d.at);
    else if (d.kind === "section" && g.kind === "layout") setLayoutAt(d.at);
    else if (d.kind === "section" && g.kind === "move-section") h.set(moveSection(doc, g.id, d.at));
  };

  const blockAction = (a: "up" | "down" | "duplicate" | "delete", bid: string) => {
    if (a === "delete") {
      h.set(removeBlock(doc, bid));
      setSel(null);
      return;
    }
    if (a === "duplicate") {
      const r = duplicateBlock(doc, bid);
      h.set(r.doc);
      setSel({ kind: "block", id: r.id });
      return;
    }
    const f = findBlock(doc, bid);
    if (!f) return;
    const col = doc.sections[f.s].cols[f.c];
    if (a === "up") {
      if (f.i > 0) h.set(moveBlock(doc, bid, { section: doc.sections[f.s].id, col: f.c, index: f.i - 1 }));
      else if (f.s > 0) {
        const prev = doc.sections[f.s - 1];
        const c = Math.min(f.c, prev.cols.length - 1);
        h.set(moveBlock(doc, bid, { section: prev.id, col: c, index: prev.cols[c].blocks.length }));
      }
    } else {
      if (f.i < col.blocks.length - 1) h.set(moveBlock(doc, bid, { section: doc.sections[f.s].id, col: f.c, index: f.i + 2 }));
      else if (f.s < doc.sections.length - 1) {
        const next = doc.sections[f.s + 1];
        h.set(moveBlock(doc, bid, { section: next.id, col: Math.min(f.c, next.cols.length - 1), index: 0 }));
      }
    }
  };
  const sectionAction = (a: "up" | "down" | "duplicate" | "delete" | "save", sid: string) => {
    if (a === "save") {
      setNaming({ kind: "section", sectionId: sid, name: "" });
      return;
    }
    const i = findSection(doc, sid);
    if (a === "delete") {
      h.set(removeSection(doc, sid));
      setSel(null);
    } else if (a === "duplicate") {
      const r = duplicateSection(doc, sid);
      h.set(r.doc);
      setSel({ kind: "section", id: r.id });
    } else if (a === "up" && i > 0) h.set(moveSection(doc, sid, i - 1));
    else if (a === "down" && i < doc.sections.length - 1) h.set(moveSection(doc, sid, i + 2));
  };

  /* keyboard: undo/redo, delete, duplicate, escape */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      const typing = t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName);
      const mod = e.ctrlKey || e.metaKey;
      if (e.key === "Escape") {
        if (editing) setEditing(null);
        else setSel(null);
        return;
      }
      if (typing) return;
      if (mod && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) h.redo();
        else h.undo();
      } else if (mod && e.key.toLowerCase() === "y") {
        e.preventDefault();
        h.redo();
      } else if ((e.key === "Delete" || e.key === "Backspace") && sel) {
        e.preventDefault();
        if (sel.kind === "block") blockAction("delete", sel.id);
        else sectionAction("delete", sel.id);
      } else if (mod && e.key.toLowerCase() === "d" && sel) {
        e.preventDefault();
        if (sel.kind === "block") blockAction("duplicate", sel.id);
        else sectionAction("duplicate", sel.id);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const helpers: PanelHelpers = useMemo(
    () => ({
      pickImage: (cb) => setImgCb(() => cb),
      pickProducts: (initialItems, cb) => setProdCb({ initial: initialItems, cb }),
      feedItems,
      aiContext: () => docWords(latest.current.doc),
    }),
    [feedItems],
  );

  const saveBadge =
    save.state === "saving" ? (
      <span className="inline-flex items-center gap-1 text-[0.72rem] text-[var(--wms-muted)]">
        <Loader2 size={13} className="animate-spin" /> Saving
      </span>
    ) : save.state === "error" ? (
      <button type="button" onClick={() => void saveNow().catch(() => {})} className="inline-flex items-center gap-1 text-[0.72rem] text-[var(--wms-status-danger-fg)]" title={save.err}>
        <CircleAlert size={13} /> Not saved, retry
      </button>
    ) : (
      <span className="inline-flex items-center gap-1 text-[0.72rem] text-[var(--wms-muted)]" title={`Saved ${new Date(save.at).toLocaleTimeString()}`}>
        <Check size={13} className="text-[var(--wms-status-success-fg)]" /> Saved
      </span>
    );

  const panelTitle = selBlock ? BLOCK_LABEL[selBlock.type] : selSection ? "Section" : rail === "add" ? "Add content" : rail === "styles" ? "Edit styles" : "Inbox";
  const railBtn = (k: typeof rail, icon: React.ReactNode, label: string) => (
    <button
      key={k}
      type="button"
      title={label}
      aria-label={label}
      onClick={() => {
        setRail(k);
        setSel(null);
        setEditing(null);
        setCollapsed(false);
      }}
      className={`grid h-10 w-10 place-items-center rounded-md ${rail === k && !sel ? "bg-[var(--wms-accent)]/15 text-[var(--wms-accent)]" : "text-[var(--wms-muted)] hover:bg-[var(--wms-surface-elevated)] hover:text-[var(--wms-fg)]"}`}
    >
      {icon}
    </button>
  );

  return (
    <BrandColors.Provider value={kit.kit?.colors ?? []}>
    <div className="fixed inset-0 z-[60] flex flex-col bg-[var(--wms-bg)]">
      {flash && (
        <div role="status" className="fixed bottom-5 left-1/2 z-[80] -translate-x-1/2 rounded-md bg-[#1F2430] px-4 py-2.5 text-[0.8rem] text-white shadow-lg">
          {flash}
        </div>
      )}
      {naming && (
        <Modal
          title={naming.kind === "template" ? "Save as a template" : "Save this section"}
          onClose={() => setNaming(null)}
          footer={
            <>
              <button type="button" className={ghostBtn} onClick={() => setNaming(null)}>
                Cancel
              </button>
              <button type="button" className={primaryBtn} disabled={naming.busy} onClick={() => void saveNamed()}>
                {naming.busy ? "Saving…" : "Save"}
              </button>
            </>
          }
        >
          <div className="flex flex-col gap-2 p-5">
            <label htmlFor="ce-save-name" className="text-[0.78rem] text-[var(--wms-muted)]">
              {naming.kind === "template" ? "New emails can start from this template (New email → Your templates). This email stays as it is." : "Reuse it in any email: Add content → Saved. Each email gets its own copy."}
            </label>
            <input
              id="ce-save-name"
              autoFocus
              className={inputCls}
              value={naming.name}
              maxLength={80}
              placeholder={naming.kind === "template" ? "e.g. Weekly new arrivals" : "e.g. Store footer"}
              onChange={(e) => setNaming({ ...naming, name: e.target.value, err: undefined })}
              onKeyDown={(e) => e.key === "Enter" && void saveNamed()}
            />
            {naming.err && <p className="text-[0.75rem] text-[var(--wms-status-danger-fg)]">{naming.err}</p>}
          </div>
        </Modal>
      )}
      {checking && (
        <AiCheck
          doc={doc}
          subject={subject}
          preheader={preheader}
          onClose={() => setChecking(false)}
          onGo={(bid) => {
            setChecking(false);
            if (!bid) {
              setSel(null);
              setRail("inbox");
              setCollapsed(false);
              return;
            }
            setSel({ kind: "block", id: bid });
            setCollapsed(false);
            requestAnimationFrame(() => document.querySelector(`[data-ce-block="${bid}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" }));
          }}
        />
      )}
      {/* top bar */}
      <header className="flex h-11 shrink-0 items-center gap-3 border-b border-[var(--wms-border)] bg-[var(--wms-surface)] px-3">
        <button type="button" onClick={exit} title="Exit editor" aria-label="Exit editor" className="grid h-8 w-8 place-items-center rounded text-[var(--wms-muted)] hover:bg-[var(--wms-surface-elevated)] hover:text-[var(--wms-fg)]">
          <ArrowLeft size={17} />
        </button>
        <input value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Email name" className="h-8 w-[min(340px,40vw)] rounded border border-transparent bg-transparent px-2 text-[0.88rem] font-semibold text-[var(--wms-fg)] hover:border-[var(--wms-border)] focus:border-[var(--wms-accent)] focus:outline-none" />
        {saveBadge}
        <div className="ml-auto flex items-center gap-2">
          <button type="button" onClick={() => setVersions(!versions)} title="Version history" aria-label="Version history" className={`grid h-8 w-8 place-items-center rounded ${versions ? "bg-[var(--wms-surface-elevated)] text-[var(--wms-fg)]" : "text-[var(--wms-muted)] hover:text-[var(--wms-fg)]"}`}>
            <History size={17} />
          </button>
          <button type="button" onClick={() => setNaming({ kind: "template", name: title })} title="Save as a template (start new emails from it)" className="flex h-8 items-center gap-1.5 rounded px-2.5 text-[0.8rem] text-[var(--wms-muted)] hover:bg-[var(--wms-surface-elevated)] hover:text-[var(--wms-fg)]">
            <BookmarkPlus size={16} />
            <span className="max-md:hidden">Save as template</span>
          </button>
          <button type="button" onClick={() => setChecking(true)} title="Check the words, links, pictures and personal tags before sending" className="flex h-8 items-center gap-1.5 rounded px-2.5 text-[0.8rem] text-[var(--wms-muted)] hover:bg-[var(--wms-surface-elevated)] hover:text-[var(--wms-fg)]">
            <ListChecks size={16} />
            <span className="max-md:hidden">Check</span>
          </button>
          <span className="h-5 w-px bg-[var(--wms-border)]" />
          <button
            type="button"
            className="h-8 rounded border border-[var(--wms-border)] px-3 text-[0.8rem] font-semibold text-[var(--wms-fg)] hover:bg-[var(--wms-surface-elevated)]"
            onClick={async () => {
              try {
                await saveNow();
                setPreview(true);
              } catch {
                /* shown in the bar */
              }
            }}
          >
            Preview and test
          </button>
          <button type="button" className="h-8 rounded bg-[var(--wms-accent)] px-3.5 text-[0.8rem] font-semibold text-[var(--wms-accent-fg)]" onClick={exit}>
            Done
          </button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* rail */}
        <nav className="flex w-14 shrink-0 flex-col items-center gap-1 border-r border-[var(--wms-border)] bg-[var(--wms-surface)] py-2" aria-label="Editor tools">
          {railBtn("add", <Plus size={19} />, "Add content")}
          {railBtn("styles", <Palette size={19} />, "Edit styles")}
          {railBtn("inbox", <Mail size={19} />, "Subject line and preview text")}
        </nav>
        {/* left panel */}
        {!collapsed && (
          <aside className="flex w-[335px] shrink-0 flex-col border-r border-[var(--wms-border)] bg-[var(--wms-surface)]">
            <div className="flex h-11 shrink-0 items-center justify-between border-b border-[var(--wms-border)] px-4">
              <div className="flex items-center gap-1.5">
                {sel && (
                  <button type="button" aria-label="Back" onClick={() => setSel(null)} className="grid h-7 w-7 place-items-center rounded text-[var(--wms-muted)] hover:text-[var(--wms-fg)]">
                    <ChevronLeft size={16} />
                  </button>
                )}
                <h3 className="text-[0.88rem] font-semibold text-[var(--wms-fg)]">{panelTitle}</h3>
              </div>
              <button type="button" onClick={() => setCollapsed(true)} title="Hide panel" className="text-[0.72rem] text-[var(--wms-muted)] hover:text-[var(--wms-fg)]">
                Hide
              </button>
            </div>
            <div className="flex min-h-0 flex-1 flex-col">
              {selBlock ? (
                <BlockPanel key={selBlock.id} block={selBlock} h={helpers} onChange={(b: Block, key) => h.set((d) => updateBlock(d, b.id, () => b), key ? `${b.id}:${key}` : "")} />
              ) : selSection ? (
                <SectionPanel
                  key={selSection.id}
                  section={selSection}
                  pickImage={helpers.pickImage}
                  onChange={(s, key) => h.set((d) => updateSection(d, s.id, () => s), key ? `${s.id}:${key}` : "")}
                  onLayout={(ws) => h.set((d) => setLayout(d, selSection.id, ws))}
                />
              ) : rail === "add" ? (
                <AddContentPanel
                  setDrag={setDrag}
                  onAdd={addBlock}
                  onAddLayout={() => setLayoutAt(afterSection())}
                  onAddPrebuilt={(pid) => addPrebuilt(pid)}
                  saved={saved}
                  onAddSaved={(sid) => addSaved(sid)}
                  onDeleteSaved={(sid, name) => void deleteSaved(sid, name)}
                />
              ) : rail === "styles" ? (
                <StylesPanel
                  styles={doc.styles}
                  onChange={(st, key) => h.set((d) => ({ ...d, styles: st }), key ? `styles:${key}` : "")}
                  kit={kit}
                  onApplyKit={() => kit.kit && (h.set((d) => ({ ...d, styles: kit.kit!.styles })), setKit((k) => ({ ...k, msg: "Brand kit used. Undo (Ctrl+Z) brings the old styles back." })))}
                  onSaveKit={() => void putKit({ styles: doc.styles, colors: kit.kit?.colors ?? docColors(doc) }, "Saved as the brand kit. New blank emails start with these styles.")}
                  onKitColors={(colors) => kit.kit && void putKit({ ...kit.kit, colors }, "Brand colours saved.")}
                />
              ) : (
                <div className="min-h-0 overflow-y-auto">
                  <Group title="Inbox">
                    <Field label="Subject line">
                      <Text value={subject} onChange={setSubject} placeholder="What people see first in their inbox" />
                    </Field>
                    <Field label="Preview text">
                      <Text value={preheader} onChange={setPreheader} placeholder="The grey line after the subject" />
                    </Field>
                    <p className="text-[0.7rem] leading-relaxed text-[var(--wms-muted)]">
                      A new campaign that uses this email starts with these. You can type {"{{first_name|there}}"} to use the person&apos;s name.
                    </p>
                    <p className="text-[0.7rem] text-[var(--wms-muted)]">Subject: {subject.length} characters (about 40–60 reads best on phones).</p>
                  </Group>
                  <AiSubjects
                    doc={doc}
                    onUse={(sj, ph) => {
                      setSubject(sj);
                      setPreheader(ph);
                    }}
                  />
                </div>
              )}
            </div>
          </aside>
        )}

        {/* canvas */}
        <main className="relative min-w-0 flex-1 overflow-auto bg-[#E9ECF1]" onDragEnd={() => setDrop(null)}>
          {collapsed && (
            <button type="button" onClick={() => setCollapsed(false)} className="absolute left-3 top-3 z-40 h-8 rounded border border-[#d5d9e0] bg-white px-3 text-[0.75rem] text-[#2b2f36] shadow-sm">
              Show panel
            </button>
          )}
          {editing ? (
            <TextBar />
          ) : (
            <div className="sticky top-3 z-40 mx-auto flex w-fit items-center gap-0.5 rounded-lg border border-[#E3E6EC] bg-white p-1 shadow-md">
              <button type="button" title="Undo (Ctrl+Z)" aria-label="Undo" disabled={!h.canUndo} onClick={h.undo} className="grid h-8 w-8 place-items-center rounded text-[#2b2f36] hover:bg-[#EEF1F6] disabled:opacity-30">
                <Undo2 size={16} />
              </button>
              <button type="button" title="Redo (Ctrl+Shift+Z)" aria-label="Redo" disabled={!h.canRedo} onClick={h.redo} className="grid h-8 w-8 place-items-center rounded text-[#2b2f36] hover:bg-[#EEF1F6] disabled:opacity-30">
                <Redo2 size={16} />
              </button>
              <span className="mx-1 h-5 w-px bg-[#E3E6EC]" />
              <button type="button" title="Desktop" aria-label="Desktop" aria-pressed={!mobile} onClick={() => setMobile(false)} className={`grid h-8 w-8 place-items-center rounded ${!mobile ? "bg-[#EAF1FE] text-[#2F6FED]" : "text-[#2b2f36] hover:bg-[#EEF1F6]"}`}>
                <Monitor size={16} />
              </button>
              <button type="button" title="Mobile" aria-label="Mobile" aria-pressed={mobile} onClick={() => setMobile(true)} className={`grid h-8 w-8 place-items-center rounded ${mobile ? "bg-[#EAF1FE] text-[#2F6FED]" : "text-[#2b2f36] hover:bg-[#EEF1F6]"}`}>
                <Smartphone size={16} />
              </button>
            </div>
          )}
          <div className="pt-3">
            <Canvas
              doc={doc}
              mobile={mobile}
              sel={sel}
              hover={hover}
              editing={editing}
              drag={drag}
              liveDrag={() => dragRef.current}
              drop={drop}
              onSelect={setSel}
              onHover={setHover}
              onEdit={setEditing}
              onDrop={onDrop}
              setDrop={setDrop}
              setDrag={(d) => {
                setDrag(d);
                if (!d) setDrop(null);
              }}
              onText={(bid, html) => h.set((d) => updateBlock(d, bid, (b) => (b.type === "text" ? { ...b, html } : b)), `text:${bid}`)}
              blockAction={blockAction}
              sectionAction={sectionAction}
            />
          </div>
          {drag && !isSectionDrag(drag) && doc.sections.length === 0 && <p className="text-center text-[0.75rem] text-[#5b6170]">Add a section first (Layout → Section).</p>}
        </main>

        {versions && (
          <VersionsPanel
            id={initial.id}
            onClose={() => setVersions(false)}
            onRestore={(d) => {
              h.set(d);
              setSel(null);
            }}
          />
        )}
      </div>

      {imgCb && (
        <ImagePicker
          onClose={() => setImgCb(null)}
          onPick={(i) => {
            imgCb(i);
            setImgCb(null);
          }}
        />
      )}
      {prodCb && (
        <ProductPicker
          initial={prodCb.initial}
          onClose={() => setProdCb(null)}
          onDone={(items) => {
            prodCb.cb(items);
            setProdCb(null);
          }}
        />
      )}
      {layoutAt != null && (
        <LayoutDialog
          onClose={() => setLayoutAt(null)}
          onPick={(ws) => {
            const r = addSection(doc, layoutAt, ws);
            h.set(r.doc);
            setSel({ kind: "section", id: r.id });
            setLayoutAt(null);
          }}
        />
      )}
      {preview && (
        <PreviewSheet
          id={initial.id}
          doc={doc}
          stamp={save.at}
          lang={lang}
          setLang={() => setLang((l) => ({ ...l, status: "running" }))}
          translate={async () => {
            await saveNow();
            await fetch(`/api/email/editor/${initial.id}/action`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "translate" }) });
            // Translation runs in the background (about a minute); check back.
            const poll = async (n: number) => {
              const r = await fetch(`/api/email/editor/${initial.id}`, { cache: "no-store" });
              const j = (await r.json()) as { email?: Loaded };
              const e = j.email;
              if (e && e.translate_status !== "running") return setLang({ status: e.translate_status, es: e.has_es, pt: e.has_pt });
              if (n < 40) setTimeout(() => void poll(n + 1), 5000);
            };
            setTimeout(() => void poll(0), 5000);
          }}
          onClose={() => setPreview(false)}
        />
      )}
    </div>
    </BrandColors.Provider>
  );
}

