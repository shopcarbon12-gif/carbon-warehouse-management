import { redirect } from "next/navigation";

export default function LocationsLegacyRedirect() {
  redirect("/overview/locations");
}
