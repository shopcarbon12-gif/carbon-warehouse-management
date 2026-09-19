"use client";

import { useEffect } from "react";
import { installTextSelectionClickGuard } from "@/lib/text-selection-click-guard";

/** Mounted once in the root layout. Renders nothing. */
export function TextSelectionClickGuard() {
  useEffect(() => installTextSelectionClickGuard(document), []);
  return null;
}
