import { env } from "../../env";
import { getSettings, type Settings } from "../../settings";
import { generateWithClaude } from "./claude";
import { generateWithGemini } from "./gemini";
import type { AiMetadata, AiMetadataInput } from "./prompt";

export type { AiChapter, AiMetadata, AiMetadataInput } from "./prompt";

export type AiProvider = "claude" | "gemini";

export const PROVIDER_LABELS: Record<AiProvider, string> = { claude: "Claude", gemini: "Gemini" };

/**
 * Which provider names videos. "auto" prefers Claude when its key is set and
 * falls back to Gemini (free tier). An explicit choice without its key is unavailable.
 */
export function resolveProvider(settings: Pick<Settings, "aiProvider"> = getSettings()): AiProvider | null {
  const hasClaude = Boolean(env().ANTHROPIC_API_KEY);
  const hasGemini = Boolean(env().GEMINI_API_KEY);
  switch (settings.aiProvider) {
    case "claude":
      return hasClaude ? "claude" : null;
    case "gemini":
      return hasGemini ? "gemini" : null;
    default:
      return hasClaude ? "claude" : hasGemini ? "gemini" : null;
  }
}

export function isAiConfigured(): boolean {
  return resolveProvider() !== null;
}

export async function generateWithAi(input: AiMetadataInput): Promise<AiMetadata & { provider: AiProvider }> {
  const settings = getSettings();
  const provider = resolveProvider(settings);
  if (!provider) throw new Error("No hay ninguna API key de IA configurada (ANTHROPIC_API_KEY o GEMINI_API_KEY)");
  const result =
    provider === "claude" ? await generateWithClaude(input, settings.aiModel) : await generateWithGemini(input, settings.geminiModel);
  return { ...result, provider };
}
