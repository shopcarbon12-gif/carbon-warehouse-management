"use client";

/**
 * Email editor — the canvas (Klaviyo's middle area): the email drawn with the SAME renderer that
 * makes the sent email (lib/email-editor/render.ts), with
 *  - hover: thin grey outline + grey name tab; selected: blue outline + blue name tab + toolbar on
 *    the left (edit text, move up/down, duplicate, delete);
 *  - drag and drop: blocks from the left panel or from the canvas land between blocks (blue line);
 *    sections, pre-built sections and column layouts land between sections;
 *  - double-click a text block to type in it, with the text toolbar at the top of the canvas.
 */
import { useEffect, useRef, type CSSProperties, type DragEvent, type ReactNode } from "react";
import { ArrowDown, ArrowUp, BookmarkPlus, Copy, GripVertical, Pencil, Trash2 } from "lucide-react";
import { columnWidths, renderBlock } from "@/lib/email-editor/render";
import { BLOCK_LABEL, fontStack, type Block, type EmailDoc, type GlobalStyles, type HeadingKey, type Section } from "@/lib/email-editor/types";
import type { Sel, Spot } from "./state";

export type Drag =
  | { kind: "new"; type: Block["type"] }
  | { kind: "move"; id: string }
  | { kind: "prebuilt"; id: string }
  | { kind: "saved"; id: string }
  | { kind: "layout" }
  | { kind: "move-section"; id: string }
  | null;
export type Drop = { kind: "block"; spot: Spot } | { kind: "section"; at: number } | null;

export const isSectionDrag = (d: Drag) => !!d && (d.kind === "prebuilt" || d.kind === "saved" || d.kind === "layout" || d.kind === "move-section");

type Props = {
  doc: EmailDoc;
  mobile: boolean;
  sel: Sel;
  hover: string | null;
  editing: string | null;
  drag: Drag;
  /** The drag right now (events can run before React draws the latest state). */
  liveDrag: () => Drag;
  drop: Drop;
  onSelect: (s: Sel) => void;
  onHover: (id: string | null) => void;
  onEdit: (id: string | null) => void;
  onDrop: (d: Drop) => void;
  setDrop: (d: Drop) => void;
  setDrag: (d: Drag) => void;
  onText: (id: string, html: string) => void;
  blockAction: (a: "up" | "down" | "duplicate" | "delete", id: string) => void;
  sectionAction: (a: "up" | "down" | "duplicate" | "delete" | "save", id: string) => void;
};

const BLUE = "#2F6FED";

/** Scoped CSS that styles the text being typed like the email (the canvas has no inline styles while editing). */
function editCss(s: GlobalStyles, mobile: boolean, scope: string): string {
  const k: [HeadingKey, string][] = [
    ["body", "p,div,li"],
    ["h1", "h1"],
    ["h2", "h2"],
    ["h3", "h3"],
    ["h4", "h4"],
  ];
  const rules = k
    .map(([key, sel]) => {
      const t = s.text[key];
      return sel
        .split(",")
        .map((x) => `${scope} ${x}`)
        .join(",") + `{margin:0;font-family:${fontStack(t.family)};font-size:${mobile ? s.mobile.sizes[key] : t.size}px;line-height:${t.lh};color:${t.color};font-weight:${t.bold ? 700 : 400};font-style:${t.italic ? "italic" : "normal"};letter-spacing:${t.ls}px;text-align:${t.align}}`;
    })
    .join("");
  return `${rules}${scope} a{color:${s.link.color};text-decoration:${s.link.underline ? "underline" : "none"};font-weight:${s.link.bold ? 700 : "inherit"}}${scope} ul,${scope} ol{margin:0;padding-left:24px}${scope}{outline:none;min-height:1.2em;cursor:text}`;
}

function TextEditing({ block, styles, mobile, onText }: { block: Extract<Block, { type: "text" }>; styles: GlobalStyles; mobile: boolean; onText: (html: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const scope = `ce-edit-${block.id}`;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.innerHTML = block.html;
    el.focus();
    const r = document.createRange();
    r.selectNodeContents(el);
    r.collapse(false);
    const s = window.getSelection();
    s?.removeAllRanges();
    s?.addRange(r);
    document.execCommand("styleWithCSS", false, "true");
    document.execCommand("defaultParagraphSeparator", false, "p");
    // Only when another block starts being edited; typing keeps its own DOM.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [block.id]);
  const p = block.pad;
  const a = block.areaPad;
  return (
    <div style={{ padding: `${p.t}px ${mobile && block.fullMobile ? 0 : p.r}px ${p.b}px ${mobile && block.fullMobile ? 0 : p.l}px`, background: block.bg ?? undefined }}>
      <style>{editCss(styles, mobile, `.${scope}`)}</style>
      <div style={{ padding: `${a.t}px ${a.r}px ${a.b}px ${a.l}px`, background: block.areaBg ?? undefined, border: block.border ? `${block.border.width}px ${block.border.style} ${block.border.color}` : undefined }}>
        <div
          ref={ref}
          className={scope}
          contentEditable
          suppressContentEditableWarning
          data-ce-editable="1"
          onInput={(e) => onText((e.target as HTMLDivElement).innerHTML)}
          onPaste={(e) => {
            // Pasted text arrives as plain text (no outside styles or scripts).
            e.preventDefault();
            document.execCommand("insertText", false, e.clipboardData.getData("text/plain"));
          }}
        />
      </div>
    </div>
  );
}

function Tab({ text, color, top = true }: { text: string; color: string; top?: boolean }) {
  return (
    <span
      className="pointer-events-none absolute left-0 z-20 whitespace-nowrap rounded-t px-1.5 py-[1px] text-[10px] font-semibold leading-[14px] text-white"
      style={{ background: color, ...(top ? { bottom: "100%" } : { top: 0 }) }}
    >
      {text}
    </span>
  );
}

function ToolBtn({ title, onClick, children, danger }: { title: string; onClick: () => void; children: ReactNode; danger?: boolean }) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={`grid h-8 w-8 place-items-center rounded text-[#33363d] hover:bg-[#EEF1F6] ${danger ? "hover:text-[#C62828]" : ""}`}
    >
      {children}
    </button>
  );
}

function Line({ vertical = false }: { vertical?: boolean }) {
  return <div className="pointer-events-none relative z-30" style={vertical ? {} : { height: 0 }}><div style={{ position: "absolute", left: 0, right: 0, top: -2, height: 4, borderRadius: 2, background: BLUE }} /></div>;
}

export function Canvas(p: Props) {
  const { doc, mobile } = p;
  const s = doc.styles;
  const width = mobile ? 375 : s.width;

  const overBlock = (e: DragEvent, sec: Section, col: number, index: number) => {
    if (!p.liveDrag() || isSectionDrag(p.liveDrag())) return;
    e.preventDefault();
    e.stopPropagation();
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const after = e.clientY > r.top + r.height / 2;
    const spot = { section: sec.id, col, index: index + (after ? 1 : 0) };
    const cur = p.drop;
    if (!(cur?.kind === "block" && cur.spot.section === spot.section && cur.spot.col === spot.col && cur.spot.index === spot.index)) p.setDrop({ kind: "block", spot });
  };
  const overSection = (e: DragEvent, i: number) => {
    if (!isSectionDrag(p.liveDrag())) return;
    e.preventDefault();
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const at = i + (e.clientY > r.top + r.height / 2 ? 1 : 0);
    if (!(p.drop?.kind === "section" && p.drop.at === at)) p.setDrop({ kind: "section", at });
  };
  const doDrop = (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    p.onDrop(p.drop);
  };

  return (
    <div
      className="min-h-full"
      style={{ background: s.pageBg, padding: `${mobile ? 16 : s.marginTop}px ${mobile ? s.mobile.margin : 24}px 64px` }}
      onClick={() => {
        p.onEdit(null);
        p.onSelect(null);
      }}
      onClickCapture={(e) => {
        // Links in the email never navigate inside the editor.
        if ((e.target as HTMLElement).closest("a") && !(e.target as HTMLElement).closest("[data-ce-editable]")) e.preventDefault();
      }}
      onDragOver={(e) => {
        if (isSectionDrag(p.liveDrag()) && doc.sections.length === 0) {
          e.preventDefault();
          p.setDrop({ kind: "section", at: 0 });
        }
      }}
      onDrop={doDrop}
    >
      <div
        className="mx-auto"
        style={{
          width,
          maxWidth: "100%",
          background: s.contentBg,
          borderRadius: s.radius,
          border: s.border ? `${s.border.width}px ${s.border.style} ${s.border.color}` : undefined,
          padding: `${s.pad.t}px ${s.pad.r}px ${s.pad.b}px ${s.pad.l}px`,
          fontFamily: fontStack(s.text.body.family),
        }}
      >
        {doc.sections.length === 0 && (
          <div className="grid h-40 place-items-center border-2 border-dashed border-[#B9C3D3] text-[13px] text-[#6B7280]">Drag a section or a layout here</div>
        )}
        {doc.sections.map((sec, si) => {
          const hidden = (sec.visibility === "desktop" && mobile) || (sec.visibility === "mobile" && !mobile);
          const widths = columnWidths(sec, s, mobile);
          const stacked = mobile && sec.stack !== "none";
          const order = stacked && sec.stack === "right-first" ? [...sec.cols.keys()].reverse() : [...sec.cols.keys()];
          const selected = p.sel?.kind === "section" && p.sel.id === sec.id;
          const hov = p.hover === sec.id;
          const secStyle: CSSProperties = {
            padding: `${sec.pad.t}px ${sec.pad.r}px ${sec.pad.b}px ${sec.pad.l}px`,
            background: sec.bg ?? undefined,
            backgroundImage: sec.bgImage ? `url('${sec.bgImage}')` : undefined,
            backgroundSize: "cover",
            backgroundPosition: "center",
            outline: selected ? `2px solid ${BLUE}` : hov ? "1px dashed #9AA3B2" : undefined,
            outlineOffset: -1,
            opacity: hidden ? 0.35 : 1,
          };
          return (
            <div key={sec.id}>
              {p.drop?.kind === "section" && p.drop.at === si && <Line />}
              <div
                className="relative"
                style={secStyle}
                onMouseOver={(e) => {
                  if (!(e.target as HTMLElement).closest("[data-ce-block]")) p.onHover(sec.id);
                }}
                onMouseLeave={() => p.onHover(null)}
                onClick={(e) => {
                  e.stopPropagation();
                  p.onEdit(null);
                  p.onSelect({ kind: "section", id: sec.id });
                }}
                onDragOver={(e) => overSection(e, si)}
                onDrop={doDrop}
              >
                {(selected || hov) && <Tab text={`Section${hidden ? " (hidden here)" : ""}`} color={selected ? BLUE : "#8B93A3"} top={false} />}
                {selected && (
                  <div className="absolute -right-11 top-0 z-30 flex flex-col rounded-md border border-[#E3E6EC] bg-white p-0.5 shadow-md">
                    <span
                      draggable
                      onDragStart={(e) => {
                        e.dataTransfer.setData("text/plain", "section");
                        e.dataTransfer.effectAllowed = "move";
                        p.setDrag({ kind: "move-section", id: sec.id });
                      }}
                      onDragEnd={() => p.setDrag(null)}
                      title="Drag to move"
                      className="grid h-8 w-8 cursor-grab place-items-center text-[#33363d]"
                    >
                      <GripVertical size={15} />
                    </span>
                    <ToolBtn title="Move up" onClick={() => p.sectionAction("up", sec.id)}>
                      <ArrowUp size={15} />
                    </ToolBtn>
                    <ToolBtn title="Move down" onClick={() => p.sectionAction("down", sec.id)}>
                      <ArrowDown size={15} />
                    </ToolBtn>
                    <ToolBtn title="Duplicate section" onClick={() => p.sectionAction("duplicate", sec.id)}>
                      <Copy size={15} />
                    </ToolBtn>
                    <ToolBtn title="Save section (reuse it in any email)" onClick={() => p.sectionAction("save", sec.id)}>
                      <BookmarkPlus size={15} />
                    </ToolBtn>
                    <ToolBtn title="Delete section" danger onClick={() => p.sectionAction("delete", sec.id)}>
                      <Trash2 size={15} />
                    </ToolBtn>
                  </div>
                )}
                <div style={{ background: sec.contentBg ?? undefined, display: stacked ? "block" : "flex", gap: stacked ? 0 : sec.gap, alignItems: sec.valign === "middle" ? "center" : sec.valign === "bottom" ? "flex-end" : "flex-start" }}>
                  {order.map((ci, k) => {
                    const col = sec.cols[ci];
                    const w = widths[ci];
                    return (
                      <div
                        key={col.id}
                        style={stacked ? { paddingTop: k ? 12 : 0 } : { width: `${w}px`, flex: `0 0 ${w}px`, minWidth: 0 }}
                        className="relative"
                        onDragOver={(e) => {
                          if (!p.liveDrag() || isSectionDrag(p.liveDrag())) return;
                          if (col.blocks.length) return;
                          e.preventDefault();
                          e.stopPropagation();
                          if (!(p.drop?.kind === "block" && p.drop.spot.section === sec.id && p.drop.spot.col === ci)) p.setDrop({ kind: "block", spot: { section: sec.id, col: ci, index: 0 } });
                        }}
                        onDrop={doDrop}
                      >
                        {col.blocks.length === 0 && (
                          <div
                            className="grid min-h-[96px] place-items-center border border-dashed text-center text-[12px]"
                            style={{
                              borderColor: p.drop?.kind === "block" && p.drop.spot.section === sec.id && p.drop.spot.col === ci ? BLUE : "#B9C3D3",
                              background: p.drop?.kind === "block" && p.drop.spot.section === sec.id && p.drop.spot.col === ci ? "#EAF1FE" : "rgba(233,236,242,.55)",
                              color: "#6B7280",
                            }}
                          >
                            Drop content here
                          </div>
                        )}
                        {col.blocks.map((b, bi) => {
                          const isSel = p.sel?.kind === "block" && p.sel.id === b.id;
                          const isHov = p.hover === b.id;
                          const editing = p.editing === b.id && b.type === "text";
                          const hiddenB = (b.visibility === "desktop" && mobile) || (b.visibility === "mobile" && !mobile);
                          const html = editing ? "" : renderBlock(b, { styles: s, width: w, mobile, canvas: true });
                          const showLine = (idx: number) => p.drop?.kind === "block" && p.drop.spot.section === sec.id && p.drop.spot.col === ci && p.drop.spot.index === idx;
                          return (
                            <div key={b.id}>
                              {showLine(bi) && <Line />}
                              <div
                                data-ce-block={b.id}
                                className="relative"
                                style={{ outline: isSel ? `2px solid ${BLUE}` : isHov ? "1px solid #9AA3B2" : undefined, outlineOffset: -1, opacity: hiddenB ? 0.35 : 1, cursor: editing ? "text" : "default" }}
                                onMouseOver={(e) => {
                                  e.stopPropagation();
                                  if (p.hover !== b.id) p.onHover(b.id);
                                }}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  if (p.editing !== b.id) p.onEdit(null);
                                  p.onSelect({ kind: "block", id: b.id });
                                }}
                                onDoubleClick={(e) => {
                                  e.stopPropagation();
                                  if (b.type === "text") p.onEdit(b.id);
                                }}
                                onDragOver={(e) => overBlock(e, sec, ci, bi)}
                                onDrop={doDrop}
                              >
                                {(isSel || isHov) && <Tab text={`${BLOCK_LABEL[b.type]}${b.type === "text" && b.asPic ? " · sent as a picture" : ""}${hiddenB ? " (hidden here)" : ""}`} color={isSel ? BLUE : "#8B93A3"} top={false} />}
                                {isSel && !editing && (
                                  <div className="absolute -left-11 top-0 z-30 flex flex-col rounded-md border border-[#E3E6EC] bg-white p-0.5 shadow-md">
                                    <span
                                      draggable
                                      onDragStart={(e) => {
                                        e.dataTransfer.setData("text/plain", "block");
                                        e.dataTransfer.effectAllowed = "move";
                                        p.setDrag({ kind: "move", id: b.id });
                                      }}
                                      onDragEnd={() => p.setDrag(null)}
                                      title="Drag to move"
                                      className="grid h-8 w-8 cursor-grab place-items-center text-[#33363d]"
                                    >
                                      <GripVertical size={15} />
                                    </span>
                                    {b.type === "text" && (
                                      <ToolBtn title="Edit text" onClick={() => p.onEdit(b.id)}>
                                        <Pencil size={15} />
                                      </ToolBtn>
                                    )}
                                    <ToolBtn title="Move up" onClick={() => p.blockAction("up", b.id)}>
                                      <ArrowUp size={15} />
                                    </ToolBtn>
                                    <ToolBtn title="Move down" onClick={() => p.blockAction("down", b.id)}>
                                      <ArrowDown size={15} />
                                    </ToolBtn>
                                    <ToolBtn title="Duplicate" onClick={() => p.blockAction("duplicate", b.id)}>
                                      <Copy size={15} />
                                    </ToolBtn>
                                    <ToolBtn title="Delete" danger onClick={() => p.blockAction("delete", b.id)}>
                                      <Trash2 size={15} />
                                    </ToolBtn>
                                  </div>
                                )}
                                {editing && b.type === "text" ? (
                                  <TextEditing block={b} styles={s} mobile={mobile} onText={(h) => p.onText(b.id, h)} />
                                ) : (
                                  <div dangerouslySetInnerHTML={{ __html: html || `<div style="padding:8px;font:12px Helvetica,Arial;color:#9AA3B2">${BLOCK_LABEL[b.type]} (hidden on ${mobile ? "phones" : "desktop"})</div>` }} />
                                )}
                              </div>
                              {bi === col.blocks.length - 1 && showLine(bi + 1) && <Line />}
                            </div>
                          );
                        })}
                      </div>
                    );
                  })}
                </div>
              </div>
              {si === doc.sections.length - 1 && p.drop?.kind === "section" && p.drop.at === si + 1 && <Line />}
            </div>
          );
        })}
      </div>
    </div>
  );
}
