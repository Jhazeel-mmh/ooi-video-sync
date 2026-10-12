import { and, eq, or } from "drizzle-orm";
import { decrypt, encrypt } from "./crypto";
import { getDb } from "./db/client";
import { accounts, workflows, type Account, type Provider } from "./db/schema";
import { AuthError, errorMessage, PermanentError, RetryableError } from "./errors";
import { logEvent } from "./events";
import { OAuthError, REAUTH_ERROR_CODES, refreshTokens, type TokenSet } from "./providers/oauth";

/** Refresh a bit before the real expiry so long requests don't start with a dying token. */
const EXPIRY_MARGIN_MS = 2 * 60 * 1000;

const inflightRefreshes = new Map<number, Promise<string>>();

export function getAccount(accountId: number): Account {
  const account = getDb().select().from(accounts).where(eq(accounts.id, accountId)).get();
  if (!account) throw new PermanentError("La cuenta vinculada ya no existe");
  return account;
}

export async function getAccessToken(accountId: number, options: { forceRefresh?: boolean } = {}): Promise<string> {
  const account = getAccount(accountId);
  if (account.status === "needs_reauth") {
    throw new AuthError(account.id, `Reconecta la cuenta "${account.displayName}" en la página de Cuentas`);
  }
  if (!options.forceRefresh && account.expiresAt.getTime() - Date.now() > EXPIRY_MARGIN_MS) {
    return decrypt(account.accessToken);
  }

  let pending = inflightRefreshes.get(accountId);
  if (!pending) {
    pending = refreshAccount(account).finally(() => inflightRefreshes.delete(accountId));
    inflightRefreshes.set(accountId, pending);
  }
  return pending;
}

async function refreshAccount(account: Account): Promise<string> {
  let tokens: TokenSet;
  try {
    tokens = await refreshTokens(account.provider, decrypt(account.refreshToken));
  } catch (error) {
    if (error instanceof OAuthError && REAUTH_ERROR_CODES.has(error.code)) {
      markNeedsReauth(account.id, error.message);
      throw new AuthError(account.id, `Reconecta la cuenta "${account.displayName}": ${error.message}`);
    }
    throw new RetryableError(`No se pudo renovar el token de "${account.displayName}": ${errorMessage(error)}`);
  }

  getDb()
    .update(accounts)
    .set({
      accessToken: encrypt(tokens.accessToken),
      // Microsoft rotates refresh tokens; Google usually keeps the old one.
      ...(tokens.refreshToken ? { refreshToken: encrypt(tokens.refreshToken) } : {}),
      expiresAt: tokens.expiresAt,
      lastError: null,
    })
    .where(eq(accounts.id, account.id))
    .run();
  return tokens.accessToken;
}

export function markNeedsReauth(accountId: number, reason: string): void {
  const db = getDb();
  db.update(accounts).set({ status: "needs_reauth", lastError: reason }).where(eq(accounts.id, accountId)).run();
  const affected = db
    .select({ id: workflows.id })
    .from(workflows)
    .where(or(eq(workflows.onedriveAccountId, accountId), eq(workflows.youtubeAccountId, accountId)))
    .all();
  for (const wf of affected) {
    logEvent({ workflowId: wf.id }, `Cuenta desconectada, workflow en pausa: ${reason}`, "error");
  }
}

export function upsertAccount(input: {
  provider: Provider;
  externalId: string;
  displayName: string;
  email?: string | null;
  avatarUrl?: string | null;
  tokens: TokenSet;
}): Account {
  const db = getDb();
  const existing = db
    .select()
    .from(accounts)
    .where(and(eq(accounts.provider, input.provider), eq(accounts.externalId, input.externalId)))
    .get();

  const refreshToken = input.tokens.refreshToken ?? (existing ? decrypt(existing.refreshToken) : undefined);
  if (!refreshToken) {
    throw new PermanentError("El proveedor no devolvió un refresh token. Revoca el acceso de la app y vuelve a conectar.");
  }

  const values = {
    provider: input.provider,
    externalId: input.externalId,
    displayName: input.displayName,
    email: input.email ?? null,
    avatarUrl: input.avatarUrl ?? null,
    accessToken: encrypt(input.tokens.accessToken),
    refreshToken: encrypt(refreshToken),
    expiresAt: input.tokens.expiresAt,
    scopes: input.tokens.scope,
    status: "active" as const,
    lastError: null,
  };

  if (existing) {
    return db.update(accounts).set(values).where(eq(accounts.id, existing.id)).returning().get();
  }
  return db.insert(accounts).values(values).returning().get();
}
