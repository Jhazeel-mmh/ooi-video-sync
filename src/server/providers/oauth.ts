import type { Provider } from "../db/schema";
import { env } from "../env";

type ProviderConfig = {
  authorizeUrl: string;
  tokenUrl: string;
  scopes: string[];
  /** Microsoft expects `scope` on token requests too, not only on authorize. */
  sendScopeOnTokenRequest: boolean;
  extraAuthorizeParams: Record<string, string>;
  credentials: () => { clientId?: string; clientSecret?: string };
};

const providers: Record<Provider, ProviderConfig> = {
  microsoft: {
    // `common` accepts both personal Microsoft accounts and work/school accounts.
    authorizeUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    tokenUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    scopes: ["offline_access", "User.Read", "Files.ReadWrite"],
    sendScopeOnTokenRequest: true,
    extraAuthorizeParams: { response_mode: "query", prompt: "select_account" },
    credentials: () => ({ clientId: env().MS_CLIENT_ID, clientSecret: env().MS_CLIENT_SECRET }),
  },
  google: {
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    // Upload + edit metadata of the channel's videos.
    scopes: ["https://www.googleapis.com/auth/youtube"],
    sendScopeOnTokenRequest: false,
    // `consent` forces Google to return a refresh token on every link.
    extraAuthorizeParams: { access_type: "offline", prompt: "consent select_account", include_granted_scopes: "true" },
    credentials: () => ({ clientId: env().GOOGLE_CLIENT_ID, clientSecret: env().GOOGLE_CLIENT_SECRET }),
  },
};

export type TokenSet = {
  accessToken: string;
  refreshToken?: string;
  expiresAt: Date;
  scope: string;
};

export class OAuthError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "OAuthError";
  }
}

/** OAuth error codes that mean the refresh token is no longer usable. */
export const REAUTH_ERROR_CODES = new Set(["invalid_grant", "interaction_required", "consent_required", "unauthorized_client"]);

export function isProvider(value: string): value is Provider {
  return value in providers;
}

export function isProviderConfigured(provider: Provider): boolean {
  const { clientId, clientSecret } = providers[provider].credentials();
  return Boolean(clientId && clientSecret);
}

export function redirectUri(provider: Provider): string {
  return new URL(`/api/auth/${provider}/callback`, env().APP_URL).toString();
}

function requireCredentials(provider: Provider) {
  const { clientId, clientSecret } = providers[provider].credentials();
  if (!clientId || !clientSecret) {
    throw new OAuthError("not_configured", `Faltan las credenciales OAuth de ${provider} en el archivo .env`);
  }
  return { clientId, clientSecret };
}

export function buildAuthorizeUrl(provider: Provider, state: string, codeChallenge: string): string {
  const config = providers[provider];
  const { clientId } = requireCredentials(provider);
  const url = new URL(config.authorizeUrl);
  url.search = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    redirect_uri: redirectUri(provider),
    scope: config.scopes.join(" "),
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    ...config.extraAuthorizeParams,
  }).toString();
  return url.toString();
}

async function tokenRequest(provider: Provider, params: Record<string, string>): Promise<TokenSet> {
  const config = providers[provider];
  const { clientId, clientSecret } = requireCredentials(provider);
  const body = new URLSearchParams({ client_id: clientId, client_secret: clientSecret, ...params });
  if (config.sendScopeOnTokenRequest) body.set("scope", config.scopes.join(" "));

  const res = await fetch(config.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body,
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || typeof json.access_token !== "string") {
    const code = typeof json.error === "string" ? json.error : `http_${res.status}`;
    const description = typeof json.error_description === "string" ? json.error_description : res.statusText;
    throw new OAuthError(code, `OAuth ${provider}: ${code} — ${description}`);
  }
  return {
    accessToken: json.access_token,
    refreshToken: typeof json.refresh_token === "string" ? json.refresh_token : undefined,
    expiresAt: new Date(Date.now() + Number(json.expires_in ?? 3600) * 1000),
    scope: typeof json.scope === "string" ? json.scope : config.scopes.join(" "),
  };
}

export function exchangeCode(provider: Provider, code: string, codeVerifier: string): Promise<TokenSet> {
  return tokenRequest(provider, {
    grant_type: "authorization_code",
    code,
    code_verifier: codeVerifier,
    redirect_uri: redirectUri(provider),
  });
}

export function refreshTokens(provider: Provider, refreshToken: string): Promise<TokenSet> {
  return tokenRequest(provider, { grant_type: "refresh_token", refresh_token: refreshToken });
}
