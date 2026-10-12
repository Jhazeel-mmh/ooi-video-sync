import { redirect } from "next/navigation";
import type { NextRequest } from "next/server";
import { randomToken, sha256Base64Url } from "@/server/crypto";
import { saveOAuthState } from "@/server/oauth-state";
import { buildAuthorizeUrl, isProvider, isProviderConfigured } from "@/server/providers/oauth";
import { requireAdmin } from "@/server/session";

export async function GET(_req: NextRequest, ctx: RouteContext<"/api/auth/[provider]/start">) {
  await requireAdmin();
  const { provider } = await ctx.params;
  if (!isProvider(provider)) return new Response("Proveedor desconocido", { status: 404 });
  if (!isProviderConfigured(provider)) {
    redirect(`/accounts?error=${encodeURIComponent(`Configura las credenciales OAuth de ${provider} en .env`)}`);
  }

  const state = randomToken();
  const verifier = randomToken(48);
  await saveOAuthState({ state, verifier, provider });
  redirect(buildAuthorizeUrl(provider, state, sha256Base64Url(verifier)));
}
