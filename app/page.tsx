import { redirect } from "next/navigation";

/** Middleware normally redirects `/` before this runs. */
export default function RootPage() {
  redirect("/login");
}
