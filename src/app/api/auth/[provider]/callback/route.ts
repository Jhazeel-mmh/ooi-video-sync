import { redirect } from "next/navigation";
import type { NextRequest } from "next/server";
import { upsertAccount } from "@/server/accounts";
import { errorMessage } from "@/server/errors";
import { consumeOAuthState } from "@/server/oauth-state";
import { exchangeCode, isProvider } from "@/server/providers/oauth";
import { fetchMicrosoftProfile } from "@/server/providers/onedrive";
import { fetchMyChannel } from "@/server/providers/youtube";
import { requireAdmin } from "@/server/session";
import { retryAuthFailures } from "@/server/videos";

export async function GET(req: NextRequest, ctx: RouteContext<"/api/auth/[provider]/callback">) {
  await requireAdmin();
  const { provider } = await ctx.params;
  if (!isProvider(provider)) return new Response("Proveedor desconocido", { status: 404 });

  const params = req.nextUrl.searchParams;
  const pending = await consumeOAuthState();
  let target: string;
  try {
    const providerError = params.get("error_description") ?? params.get("error");
    if (providerError) throw new Error(providerError);
    const code = params.get("code");
    if (!code || !pending || pending.provider !== provider || pending.state !== params.get("state")) {
      throw new Error("La solicitud de autorización expiró o no es válida. Intenta de nuevo.");
    }

    const tokens = await exchangeCode(provider, code, pending.verifier);
    let account;
    if (provider === "microsoft") {
      const profile = await fetchMicrosoftProfile(tokens.accessToken);
      account = upsertAccount({ provider, externalId: profile.id, displayName: profile.displayName, email: profile.email, tokens });
    } else {
      const channel = await fetchMyChannel(tokens.accessToken);
      account = upsertAccount({
        provider,
        externalId: channel.id,
        displayName: channel.title,
        avatarUrl: channel.avatarUrl,
        tokens,
      });
    }
    // Videos that failed while the account was disconnected pick up where they stopped.
    retryAuthFailures(account.id);
    target = `/accounts?connected=${provider}`;
  } catch (error) {
    target = `/accounts?error=${encodeURIComponent(errorMessage(error))}`;
  }
  redirect(target);
}
