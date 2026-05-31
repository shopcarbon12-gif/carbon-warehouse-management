import { redirect } from "next/navigation";

export default function LocationsLegacyRedirect() {
  redirect("/inventory/locations");
}
