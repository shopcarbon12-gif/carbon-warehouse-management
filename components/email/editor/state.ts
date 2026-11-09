/**
 * Email editor — changes to the email data (pure functions) and the undo/redo history.
 * Every change makes a new document (structuredClone), so undo is just going back a step.
 */
import { useCallback, useRef, useState } from "react";
import { cloneBlock, cloneSection, newBlock, newSection, type Block, type BlockType, type EmailDoc, type Section } from "@/lib/email-editor/types";

export type Sel = { kind: "block"; id: string } | { kind: "section"; id: string } | null;
/** Where something is dropped: a column of a section, at an index. */
export type Spot = { section: string; col: number; index: number };

const copy = (d: EmailDoc): EmailDoc => structuredClone(d);

export function findBlock(d: EmailDoc, id: string): { s: number; c: number; i: number; block: Block } | null {
  for (const [s, sec] of d.sections.entries())
    for (const [c, col] of sec.cols.entries()) {
      const i = col.blocks.findIndex((b) => b.id === id);
      if (i >= 0) return { s, c, i, block: col.blocks[i] };
    }
  return null;
}
export const findSection = (d: EmailDoc, id: string) => d.sections.findIndex((s) => s.id === id);

export function updateBlock(d: EmailDoc, id: string, fn: (b: Block) => Block | void): EmailDoc {
  const n = copy(d);
  const f = findBlock(n, id);
  if (!f) return d;
  const out = fn(n.sections[f.s].cols[f.c].blocks[f.i]);
  if (out) n.sections[f.s].cols[f.c].blocks[f.i] = out;
  return n;
}
export function updateSection(d: EmailDoc, id: string, fn: (s: Section) => Section | void): EmailDoc {
  const n = copy(d);
  const i = findSection(n, id);
  if (i < 0) return d;
  const out = fn(n.sections[i]);
  if (out) n.sections[i] = out;
  return n;
}

export function insertBlock(d: EmailDoc, spot: Spot, block: Block): EmailDoc {
  const n = copy(d);
  const s = n.sections.find((x) => x.id === spot.section);
  if (!s || !s.cols[spot.col]) return d;
  s.cols[spot.col].blocks.splice(Math.max(0, Math.min(spot.index, s.cols[spot.col].blocks.length)), 0, block);
  return n;
}
export const addNewBlock = (d: EmailDoc, spot: Spot, type: BlockType) => {
  const b = newBlock(type);
  return { doc: insertBlock(d, spot, b), id: b.id };
};

export function moveBlock(d: EmailDoc, id: string, spot: Spot): EmailDoc {
  const f = findBlock(d, id);
  if (!f) return d;
  const n = copy(d);
  const [b] = n.sections[f.s].cols[f.c].blocks.splice(f.i, 1);
  const sameCol = n.sections[f.s].id === spot.section && f.c === spot.col;
  const idx = sameCol && f.i < spot.index ? spot.index - 1 : spot.index;
  const s = n.sections.find((x) => x.id === spot.section);
  if (!s || !s.cols[spot.col]) return d;
  s.cols[spot.col].blocks.splice(idx, 0, b);
  return n;
}
export function removeBlock(d: EmailDoc, id: string): EmailDoc {
  const f = findBlock(d, id);
  if (!f) return d;
  const n = copy(d);
  n.sections[f.s].cols[f.c].blocks.splice(f.i, 1);
  return n;
}
export function duplicateBlock(d: EmailDoc, id: string): { doc: EmailDoc; id: string } {
  const f = findBlock(d, id);
  if (!f) return { doc: d, id };
  const n = copy(d);
  const c = cloneBlock(f.block);
  n.sections[f.s].cols[f.c].blocks.splice(f.i + 1, 0, c);
  return { doc: n, id: c.id };
}

export function insertSections(d: EmailDoc, at: number, sections: Section[]): EmailDoc {
  const n = copy(d);
  n.sections.splice(Math.max(0, Math.min(at, n.sections.length)), 0, ...sections);
  return n;
}
export const addSection = (d: EmailDoc, at: number, widths: number[]) => {
  const s = newSection(widths);
  return { doc: insertSections(d, at, [s]), id: s.id };
};
export function moveSection(d: EmailDoc, id: string, to: number): EmailDoc {
  const i = findSection(d, id);
  if (i < 0) return d;
  const n = copy(d);
  const [s] = n.sections.splice(i, 1);
  n.sections.splice(Math.max(0, Math.min(to > i ? to - 1 : to, n.sections.length)), 0, s);
  return n;
}
export function removeSection(d: EmailDoc, id: string): EmailDoc {
  const n = copy(d);
  n.sections = n.sections.filter((s) => s.id !== id);
  return n;
}
export function duplicateSection(d: EmailDoc, id: string): { doc: EmailDoc; id: string } {
  const i = findSection(d, id);
  if (i < 0) return { doc: d, id };
  const c = cloneSection(d.sections[i]);
  return { doc: insertSections(d, i + 1, [c]), id: c.id };
}
/** New column layout for a section: blocks of removed columns move into the last kept column. */
export function setLayout(d: EmailDoc, id: string, widths: number[]): EmailDoc {
  return updateSection(d, id, (s) => {
    const cols = widths.map((w, i) => ({ id: s.cols[i]?.id ?? Math.random().toString(36).slice(2, 10), w, blocks: s.cols[i]?.blocks ?? [] }));
    for (const extra of s.cols.slice(widths.length)) cols[cols.length - 1].blocks.push(...extra.blocks);
    s.cols = cols;
  });
}

/* -------------------------------------------------------------- history */

/**
 * The document with undo/redo. `set(next, key)` records a step; several changes with the same key
 * within 700 ms (typing in a field, dragging a slider) become ONE step.
 */
export function useHistory(initial: EmailDoc) {
  const [state, setState] = useState({ past: [] as EmailDoc[], doc: initial, future: [] as EmailDoc[] });
  const last = useRef<{ key: string; at: number } | null>(null);
  const set = useCallback((next: EmailDoc | ((d: EmailDoc) => EmailDoc), key = "") => {
    setState((st) => {
      const doc = typeof next === "function" ? next(st.doc) : next;
      if (doc === st.doc) return st;
      const now = Date.now();
      const merge = !!key && last.current?.key === key && now - last.current.at < 700;
      last.current = { key, at: now };
      return { past: merge ? st.past : [...st.past.slice(-99), st.doc], doc, future: [] };
    });
  }, []);
  const undo = useCallback(() => {
    last.current = null;
    setState((st) => (st.past.length ? { past: st.past.slice(0, -1), doc: st.past[st.past.length - 1], future: [st.doc, ...st.future] } : st));
  }, []);
  const redo = useCallback(() => {
    last.current = null;
    setState((st) => (st.future.length ? { past: [...st.past, st.doc], doc: st.future[0], future: st.future.slice(1) } : st));
  }, []);
  /** Replace without a step (loading, restoring is a step: use set). */
  const reset = useCallback((doc: EmailDoc) => setState({ past: [], doc, future: [] }), []);
  /** Change the current document without an undo step (today's products in a dynamic block). */
  const patch = useCallback((fn: (d: EmailDoc) => EmailDoc) => setState((st) => ({ ...st, doc: fn(st.doc) })), []);
  return { doc: state.doc, set, undo, redo, reset, patch, canUndo: state.past.length > 0, canRedo: state.future.length > 0 };
}
