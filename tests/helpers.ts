import { encrypt } from "@/server/crypto";
import { getDb } from "@/server/db/client";
import { accounts, workflows, type Provider } from "@/server/db/schema";

export function createAccount(provider: Provider, externalId = `${provider}-1`) {
  return getDb()
    .insert(accounts)
    .values({
      provider,
      externalId,
      displayName: `Cuenta ${provider}`,
      accessToken: encrypt("access-token"),
      refreshToken: encrypt("refresh-token"),
      expiresAt: new Date(Date.now() + 3_600_000),
      scopes: "test",
    })
    .returning()
    .get();
}

export function createWorkflow(overrides: Partial<typeof workflows.$inferInsert> = {}) {
  const onedrive = createAccount("microsoft", `ms-${Math.random()}`);
  const youtube = createAccount("google", `yt-${Math.random()}`);
  return getDb()
    .insert(workflows)
    .values({
      name: "Prueba",
      onedriveAccountId: onedrive.id,
      youtubeAccountId: youtube.id,
      driveId: "drive1",
      folderId: "folder1",
      folderPath: "/Videos",
      ...overrides,
    })
    .returning()
    .get();
}

type Handler = (url: URL, init: RequestInit) => Response | Promise<Response>;

/** Replaces global fetch; returns the list of calls made. */
export function mockFetch(handler: Handler) {
  const calls: { url: URL; init: RequestInit }[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    if (input instanceof Request) {
      // SDKs may send a Request object; expose its parts like a plain init.
      init = {
        method: input.method,
        headers: input.headers,
        body: input.body ? await input.text() : undefined,
        ...init,
      };
    }
    const url = new URL(input instanceof Request ? input.url : input);
    calls.push({ url, init });
    return handler(url, init);
  }) as typeof fetch;
  return calls;
}

export function json(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "Content-Type": "application/json", ...init.headers },
  });
}
