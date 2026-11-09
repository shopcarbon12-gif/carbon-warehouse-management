import { redirect } from "next/navigation";

/** Moved to Email Marketing → Sign-up forms (2026-11-09); old links still work. */
export default function WelcomePopupPage() {
  redirect("/marketing/signup-forms");
}
