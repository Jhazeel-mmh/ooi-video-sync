import type { NextRequest } from "next/server";
import { fetchThumbnail } from "@/server/providers/onedrive";
import { requireAdmin } from "@/server/session";
import { loadVideo } from "@/server/videos";

export async function GET(_req: NextRequest, ctx: RouteContext<"/api/videos/[id]/thumbnail">) {
  await requireAdmin();
  const { id } = await ctx.params;
  const loaded = loadVideo(Number(id));
  if (!loaded) return new Response(null, { status: 404 });

  try {
    const upstream = await fetchThumbnail(loaded.workflow.onedriveAccountId, loaded.video.driveId, loaded.video.itemId);
    if (!upstream.ok || !upstream.body) return new Response(null, { status: 404 });
    return new Response(upstream.body, {
      headers: {
        "Content-Type": upstream.headers.get("content-type") ?? "image/jpeg",
        "Cache-Control": "private, max-age=86400",
      },
    });
  } catch {
    return new Response(null, { status: 404 });
  }
}
