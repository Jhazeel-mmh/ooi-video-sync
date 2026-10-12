import { writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { QuotaError } from "@/server/errors";
import { queryUpload, startUpload, uploadFile } from "@/server/providers/youtube";
import { createAccount, json, mockFetch } from "./helpers";

const SESSION = "https://www.googleapis.com/upload/youtube/v3/videos?upload_id=abc";
const CONTENT = Buffer.from("0123456789abcdefghij"); // 20 bytes

function tempVideo() {
  const file = path.join(process.env.DATA_DIR!, `video-${Math.random()}.mp4`);
  writeFileSync(file, CONTENT);
  return file;
}

/** Minimal resumable-upload server: stores contiguous bytes, can fail on demand. */
function fakeUploadServer(options: { failOnCall?: number; acceptOnly?: number } = {}) {
  const received: Buffer[] = [];
  let stored = 0;
  let putCalls = 0;
  const calls = mockFetch((url, init) => {
    const range = new Headers(init.headers).get("content-range")!;
    if (range.startsWith("bytes */")) {
      return new Response(null, { status: 308, headers: stored > 0 ? { Range: `bytes=0-${stored - 1}` } : {} });
    }
    putCalls += 1;
    if (putCalls === options.failOnCall) throw new TypeError("fetch failed");

    const [, start, end, total] = /bytes (\d+)-(\d+)\/(\d+)/.exec(range)!.map(Number);
    expect(start).toBe(stored);
    // Optionally store only part of the chunk, like a server that cut the connection.
    const body = init.body as Buffer;
    const accepted = options.acceptOnly && putCalls === 1 ? body.subarray(0, options.acceptOnly) : body;
    received.push(Buffer.from(accepted));
    stored += accepted.length;
    if (end + 1 === total && stored === total) return json({ id: "yt123" }, { status: 201 });
    return new Response(null, { status: 308, headers: { Range: `bytes=0-${stored - 1}` } });
  });
  return { calls, data: () => Buffer.concat(received) };
}

describe("uploadFile", () => {
  it("sends the file in chunks and returns the video", async () => {
    const account = createAccount("google", "chunks");
    const server = fakeUploadServer();
    const progress: number[] = [];
    const video = await uploadFile(account.id, SESSION, tempVideo(), CONTENT.length, 0, {
      chunkSize: 8,
      onProgress: (n) => progress.push(n),
    });
    expect(video.id).toBe("yt123");
    expect(server.data().equals(CONTENT)).toBe(true);
    expect(progress).toEqual([8, 16, 20]);
    expect(server.calls.every((c) => new Headers(c.init.headers).get("authorization") === "Bearer access-token")).toBe(true);
  });

  it("asks the session where it left off after a network error", async () => {
    const account = createAccount("google", "network");
    const server = fakeUploadServer({ failOnCall: 2 });
    const video = await uploadFile(account.id, SESSION, tempVideo(), CONTENT.length, 0, { chunkSize: 8, retryDelayMs: 1 });
    expect(video.id).toBe("yt123");
    expect(server.data().equals(CONTENT)).toBe(true);
  });

  it("continues from the offset the server reports when it stored less", async () => {
    const account = createAccount("google", "partial");
    const server = fakeUploadServer({ acceptOnly: 5 });
    await uploadFile(account.id, SESSION, tempVideo(), CONTENT.length, 0, { chunkSize: 8 });
    expect(server.data().equals(CONTENT)).toBe(true);
  });
});

describe("queryUpload", () => {
  it("parses the Range header and detects expired sessions", async () => {
    const account = createAccount("google", "query");
    mockFetch(() => new Response(null, { status: 308, headers: { Range: "bytes=0-9" } }));
    expect(await queryUpload(account.id, SESSION, 20)).toEqual({ kind: "partial", offset: 10 });
    mockFetch(() => new Response(null, { status: 308 }));
    expect(await queryUpload(account.id, SESSION, 20)).toEqual({ kind: "partial", offset: 0 });
    mockFetch(() => new Response("gone", { status: 404 }));
    expect(await queryUpload(account.id, SESSION, 20)).toEqual({ kind: "expired" });
  });
});

describe("startUpload", () => {
  it("maps quotaExceeded to a QuotaError", async () => {
    const account = createAccount("google", "quota");
    mockFetch(() =>
      json({ error: { code: 403, message: "quota", errors: [{ reason: "quotaExceeded" }] } }, { status: 403 }),
    );
    const meta = {
      title: "t",
      description: "",
      tags: [],
      categoryId: "22",
      privacyStatus: "private" as const,
      madeForKids: false,
    };
    await expect(startUpload(account.id, meta, 20, "video/mp4")).rejects.toBeInstanceOf(QuotaError);
  });

  it("returns the session URL", async () => {
    const account = createAccount("google", "start");
    const calls = mockFetch(() => new Response(null, { status: 200, headers: { Location: SESSION } }));
    const meta = {
      title: "t",
      description: "d",
      tags: ["a"],
      categoryId: "22",
      privacyStatus: "public" as const,
      publishAt: new Date(Date.now() + 86_400_000),
      madeForKids: false,
    };
    expect(await startUpload(account.id, meta, 20, "video/mp4")).toBe(SESSION);
    const body = JSON.parse(calls[0].init.body as string);
    // Scheduled publishing requires the video to start as private.
    expect(body.status.privacyStatus).toBe("private");
    expect(body.status.publishAt).toBeDefined();
    expect(new Headers(calls[0].init.headers).get("x-upload-content-length")).toBe("20");
  });
});
