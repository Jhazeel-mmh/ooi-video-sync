import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { env } from "../../env";
import { RetryableError } from "../../errors";
import { buildPrompt, metadataSchema, systemPrompt, type AiMetadata, type AiMetadataInput } from "./prompt";

/** Models that accept the server-side refusal fallback. */
const FALLBACK_MODELS = new Set(["claude-opus-5-5", "claude-sonnet-5-5"]);

export async function generateWithClaude(input: AiMetadataInput, model: string): Promise<AiMetadata> {
  const apiKey = env().ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY no está configurada");
  const client = new Anthropic({ apiKey, timeout: 120_000 });
  const schema = metadataSchema(Boolean(input.chapters));

  // `create` rather than `parse`: a refusal comes back with partial text, and
  // the stop reason must be checked before attempting to parse it.
  let response;
  try {
    response = await client.beta.messages.create({
      model,
      max_tokens: 4000,
      ...(FALLBACK_MODELS.has(model) ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
      // Short creative task: low effort keeps it fast and cheap.
      output_config: { effort: "low", format: betaZodOutputFormat(schema) },
      system: systemPrompt(Boolean(input.chapters)),
      messages: [{ role: "user", content: buildPrompt(input) }],
    });
  } catch (error) {
    // The SDK already retried; a rate limit or outage is worth another try later.
    if (error instanceof Anthropic.RateLimitError || error instanceof Anthropic.InternalServerError || error instanceof Anthropic.APIConnectionError) {
      throw new RetryableError(`Claude no está disponible ahora: ${error.message}`, 60_000);
    }
    throw error;
  }

  if (response.stop_reason === "refusal") throw new Error("Claude no generó una propuesta para este video");
  if (response.stop_reason === "max_tokens") throw new Error("La respuesta de Claude quedó incompleta");
  const text = response.content.find((block) => block.type === "text")?.text ?? "";
  let parsed;
  try {
    parsed = schema.safeParse(JSON.parse(text));
  } catch {
    parsed = null;
  }
  if (!parsed?.success) throw new Error("La respuesta de Claude no tiene el formato esperado");
  return parsed.data;
}
