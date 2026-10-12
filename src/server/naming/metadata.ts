import { TZDate } from "@date-fns/tz";
import { format } from "date-fns";
import { es } from "date-fns/locale";
import { and, desc, eq, isNotNull, ne } from "drizzle-orm";
import { getDb } from "../db/client";
import { videos, type Video, type Workflow } from "../db/schema";
import { errorMessage } from "../errors";
import { getSettings } from "../settings";
import { generateWithAi } from "./ai";
import { parseTags, sanitizeDescription, sanitizeTags, sanitizeTitle } from "./sanitize";
import { formatDuration, recordingDate, renderTemplate, type TemplateVars } from "./template";

export type GeneratedMetadata = {
  title: string;
  description: string;
  tags: string[];
  source: "template" | "ai";
  /** Set when AI was requested but the template had to be used. */
  aiError?: string;
};

export function templateVars(video: Video, timeZone: string): TemplateVars {
  return {
    originalName: video.name,
    folderPath: video.path,
    date: recordingDate(video, timeZone),
    sequence: video.sequence ?? 0,
    durationMs: video.durationMs,
  };
}

function recentTitles(video: Video): string[] {
  return getDb()
    .select({ title: videos.title })
    .from(videos)
    .where(and(eq(videos.workflowId, video.workflowId), ne(videos.id, video.id), isNotNull(videos.title)))
    .orderBy(desc(videos.updatedAt))
    .limit(10)
    .all()
    .map((r) => r.title!);
}

/** Renders the workflow templates and, if requested, asks Claude to improve them. */
export async function buildMetadata(video: Video, workflow: Workflow, options: { useAi: boolean }): Promise<GeneratedMetadata> {
  const settings = getSettings();
  const vars = templateVars(video, settings.timeZone);
  const template = {
    title: sanitizeTitle(renderTemplate(workflow.titleTemplate, vars, settings.timeZone), sanitizeTitle(vars.originalName)),
    description: sanitizeDescription(renderTemplate(workflow.descriptionTemplate, vars, settings.timeZone)),
    tags: sanitizeTags(parseTags(renderTemplate(workflow.tagsTemplate, vars, settings.timeZone))),
  };
  if (!options.useAi) return { ...template, source: "template" };

  try {
    const ai = await generateWithAi(
      {
        fileName: video.name,
        folderPath: video.path,
        recordedAt: format(new TZDate(vars.date.getTime(), settings.timeZone), "EEEE d 'de' MMMM 'de' yyyy, HH:mm", {
          locale: es,
        }),
        duration: formatDuration(video.durationMs),
        channelContext: workflow.aiContext,
        template,
        recentTitles: recentTitles(video),
      },
      settings.aiModel,
    );
    return {
      title: sanitizeTitle(ai.title, template.title),
      description: sanitizeDescription(ai.description),
      tags: sanitizeTags(ai.tags),
      source: "ai",
    };
  } catch (error) {
    return { ...template, source: "template", aiError: errorMessage(error) };
  }
}
