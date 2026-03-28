"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { sessionCookieName } from "@/lib/auth";

export async function logoutAction() {
  const jar = await cookies();
  jar.set(sessionCookieName(), "", {
    httpOnly: true,
    path: "/",
    maxAge: 0,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
  });
  redirect("/login");
}
