import "server-only";
import { getIronSession, type SessionOptions } from "iron-session";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { env, isSecureOrigin } from "./env";

export const SESSION_COOKIE = "ovs_session";

export type SessionData = {
  isAdmin?: boolean;
};

function sessionOptions(): SessionOptions {
  return {
    password: env().SESSION_SECRET,
    cookieName: SESSION_COOKIE,
    ttl: 60 * 60 * 24 * 14,
    cookieOptions: { secure: isSecureOrigin(), httpOnly: true, sameSite: "lax", path: "/" },
  };
}

export async function getSession() {
  return getIronSession<SessionData>(await cookies(), sessionOptions());
}

/** Data access guard: every server action, route handler and data read calls this. */
export async function requireAdmin(): Promise<void> {
  const session = await getSession();
  if (!session.isAdmin) redirect("/login");
}
