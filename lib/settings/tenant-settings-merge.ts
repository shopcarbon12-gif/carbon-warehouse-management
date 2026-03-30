/** Shallow-deep merge for JSON patch objects (objects recurse; arrays/scalars replace). */
export function mergeDeep<T>(base: T, patch: unknown): T {
  if (patch === undefined) return base;
  if (patch === null) return base;
  if (Array.isArray(patch)) return patch as T;
  if (typeof patch !== "object") return patch as T;
  if (typeof base !== "object" || base === null || Array.isArray(base)) return patch as T;

  const out = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    const cur = out[k];
    if (
      v !== null &&
      typeof v === "object" &&
      !Array.isArray(v) &&
      typeof cur === "object" &&
      cur !== null &&
      !Array.isArray(cur)
    ) {
      out[k] = mergeDeep(cur, v) as unknown;
    } else {
      out[k] = v as unknown;
    }
  }
  return out as T;
}
