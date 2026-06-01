// Pull in the Print Tags stylesheet so the embedded <LabelPreviewCanvas/>
// (.label-stage / .dims classes) renders identically to the Print Tags page.
import "../print/print-tags.css";

export default function EncodePrintLayout({ children }: { children: React.ReactNode }) {
  return children;
}
