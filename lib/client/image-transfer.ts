/**
 * Shared helpers for getting image files out of a drag-and-drop or a paste
 * (Matrix Images tab, Carbon Studio).
 */

/** Pull image files out of a drop or clipboard payload (drag-drop + paste). */
export function imageFilesFromTransfer(dt: DataTransfer | null): File[] {
  if (!dt) return [];
  const out: File[] = [];
  if (dt.items && dt.items.length) {
    for (const it of Array.from(dt.items)) {
      if (it.kind === "file") {
        const f = it.getAsFile();
        if (f) out.push(f);
      }
    }
  }
  if (!out.length && dt.files && dt.files.length) out.push(...Array.from(dt.files));
  return out.filter((f) => f.type.startsWith("image/"));
}

/**
 * True while a drag carries files from outside the page. During dragover the
 * files themselves are not readable yet, only the "Files" type is.
 */
export function transferHasFiles(dt: DataTransfer | null): boolean {
  return !!dt && Array.from(dt.types ?? []).includes("Files");
}

/** True when a paste is aimed at somewhere the operator types text. */
export function isTextEntryTarget(el: EventTarget | Element | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el.isContentEditable) return true;
  if (el instanceof HTMLTextAreaElement) return true;
  if (el instanceof HTMLSelectElement) return false;
  if (el instanceof HTMLInputElement) {
    return !["checkbox", "radio", "button", "submit", "reset", "file", "image", "range", "color"].includes(el.type);
  }
  return false;
}
