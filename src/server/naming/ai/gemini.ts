import { GoogleGenAI } from "@google/genai";
import { z } from "zod";
import { env } from "../../env";
import { RetryableError, errorMessage } from "../../errors";
import { buildPrompt, metadataSchema, systemPrompt, type AiMetadata, type AiMetadataInput } from "./prompt";

type CreateParams = Parameters<GoogleGenAI["interactions"]["create"]>[0];

function client(): GoogleGenAI {
  const apiKey = env().GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY no está configurada");
  return new GoogleGenAI({ apiKey });
}

/** Rate limits (frequent on the free tier) and outages are retried later. */
function toError(error: unknown): Error {
  const status = typeof error === "object" && error !== null ? (error as { status?: unknown }).status : undefined;
  if (status === 429) return new RetryableError(`Gemini: límite de uso alcanzado (${errorMessage(error)})`, 60_000);
  if (typeof status === "number" && status >= 500) return new RetryableError(`Gemini no está disponible: ${errorMessage(error)}`, 60_000);
  return error instanceof Error ? error : new Error(String(error));
}

/** Sends one non-streaming request and returns its text. */
export async function geminiText(params: CreateParams, options: { timeoutMs?: number } = {}): Promise<string> {
  let interaction;
  try {
    // `store: false`: nothing is kept for later retrieval on Google's side.
    // No SDK retries: the job queue retries later, which suits per-minute quotas better.
    interaction = await client().interactions.create(
      { ...params, stream: false, store: false },
      { maxRetries: 0, timeout: options.timeoutMs ?? 120_000 },
    );
  } catch (error) {
    throw toError(error);
  }
  if (interaction.status !== "completed") {
    throw new Error(`Gemini no completó la respuesta (estado: ${interaction.status})`);
  }
  return interaction.output_text ?? "";
}

export async function generateWithGemini(input: AiMetadataInput, model: string): Promise<AiMetadata> {
  const schema = metadataSchema(Boolean(input.chapters));
  const text = await geminiText({
    model,
    system_instruction: systemPrompt(Boolean(input.chapters)),
    input: buildPrompt(input),
    response_format: { type: "text", mime_type: "application/json", schema: z.toJSONSchema(schema) },
    generation_config: { thinking_level: "low" },
  });
  let parsed;
  try {
    parsed = schema.safeParse(JSON.parse(text));
  } catch {
    parsed = null;
  }
  if (!parsed?.success) throw new Error("La respuesta de Gemini no tiene el formato esperado");
  return parsed.data;
}
