"use server";

import { setTimeout as sleep } from "node:timers/promises";
import { redirect } from "next/navigation";
import { verifyPassword } from "@/server/crypto";
import { env } from "@/server/env";
import { getSession } from "@/server/session";

export type LoginState = { error?: string };

export async function login(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const password = String(formData.get("password") ?? "");
  if (!password || !verifyPassword(password, env().ADMIN_PASSWORD_HASH)) {
    // Slow down brute-force attempts.
    await sleep(800);
    return { error: "Contraseña incorrecta" };
  }
  const session = await getSession();
  session.isAdmin = true;
  await session.save();
  redirect("/");
}

export async function logout(): Promise<void> {
  const session = await getSession();
  session.destroy();
  redirect("/login");
}
