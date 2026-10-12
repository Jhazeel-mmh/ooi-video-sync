import type { VideoStatus } from "@/server/db/schema";

export const VIDEO_FILTERS = {
  all: { label: "Todos", statuses: null },
  review: { label: "Por revisar", statuses: ["pending_review"] },
  active: {
    label: "En proceso",
    statuses: ["discovered", "queued", "downloading", "uploading", "processing", "waiting_quota"],
  },
  published: { label: "Publicados", statuses: ["published"] },
  failed: { label: "Con error", statuses: ["failed"] },
  ignored: { label: "Ignorados", statuses: ["ignored"] },
} as const satisfies Record<string, { label: string; statuses: readonly VideoStatus[] | null }>;

export type VideoFilter = keyof typeof VIDEO_FILTERS;

export function isVideoFilter(value: unknown): value is VideoFilter {
  return typeof value === "string" && value in VIDEO_FILTERS;
}

/** "Todos" hides ignored videos; they have their own tab. */
export function statusesFor(filter: VideoFilter): readonly VideoStatus[] | "all-but-ignored" {
  return VIDEO_FILTERS[filter].statuses ?? "all-but-ignored";
}
