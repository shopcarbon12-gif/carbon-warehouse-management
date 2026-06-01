import type { ReactNode } from "react";
import "./print-tags.css";

/** Scope wrapper for the ported mockup styles; the workspace renders the rest. */
export default function PrintTagsLayout({ children }: { children: ReactNode }) {
  return <div className="pt-root">{children}</div>;
}
