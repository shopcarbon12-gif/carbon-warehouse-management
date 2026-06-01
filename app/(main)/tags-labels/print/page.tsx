import { redirect } from "next/navigation";

// RFID tags is the default tab when opening Print Tags from the menu.
export default function PrintTagsIndex() {
  redirect("/tags-labels/print/rfid");
}
