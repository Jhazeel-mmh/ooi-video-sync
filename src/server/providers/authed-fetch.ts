import { getAccessToken, getAccount, markNeedsReauth } from "../accounts";
import { AuthError, RetryableError, errorMessage } from "../errors";

/**
 * `fetch` with the account's bearer token. On 401 it forces one token refresh
 * and retries; a second 401 marks the account for reconnection.
 * The body must be replayable (string/Buffer), not a stream.
 */
export async function authedFetch(accountId: number, url: string | URL, init: RequestInit = {}): Promise<Response> {
  const send = async (token: string) => {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${token}`);
    try {
      return await fetch(url, { ...init, headers });
    } catch (error) {
      if (init.signal?.aborted) throw error;
      throw new RetryableError(`Error de red: ${errorMessage(error)}`);
    }
  };

  let res = await send(await getAccessToken(accountId));
  if (res.status === 401) {
    res = await send(await getAccessToken(accountId, { forceRefresh: true }));
    if (res.status === 401) {
      const account = getAccount(accountId);
      const reason = "El proveedor rechazó el token (401)";
      markNeedsReauth(accountId, reason);
      throw new AuthError(accountId, `Reconecta la cuenta "${account.displayName}": ${reason}`);
    }
  }
  return res;
}
