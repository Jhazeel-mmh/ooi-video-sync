import "server-only";
import { sealData, unsealData } from "iron-session";
import { cookies } from "next/headers";
import type { Provider } from "./db/schema";
import { env, isSecureOrigin } from "./env";

const COOKIE = "ovs_oauth";
const TTL_SECONDS = 600;

type OAuthState = { state: string; verifier: string; provider: Provider };

export async function saveOAuthState(data: OAuthState): Promise<void> {
  const sealed = await sealData(data, { password: env().SESSION_SECRET, ttl: TTL_SECONDS });
  (await cookies()).set(COOKIE, sealed, {
    httpOnly: true,
    secure: isSecureOrigin(),
    sameSite: "lax",
    maxAge: TTL_SECONDS,
    path: "/api/auth",
  });
}

/** Reads and clears the pending OAuth state (single use). */
export async function consumeOAuthState(): Promise<OAuthState | null> {
  const jar = await cookies();
  const sealed = jar.get(COOKIE)?.value;
  jar.delete({ name: COOKIE, path: "/api/auth" });
  if (!sealed) return null;
  const data = await unsealData<Partial<OAuthState>>(sealed, { password: env().SESSION_SECRET, ttl: TTL_SECONDS });
  return data.state && data.verifier && data.provider ? (data as OAuthState) : null;
}
