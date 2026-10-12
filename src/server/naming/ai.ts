import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { env } from "../env";

const MetadataSchema = z.object({
  title: z.string().describe("Título del video, máximo 100 caracteres"),
  description: z.string().describe("Descripción del video"),
  tags: z.array(z.string()).describe("Etiquetas, sin #"),
});

export type AiMetadata = z.infer<typeof MetadataSchema>;

export type AiMetadataInput = {
  fileName: string;
  folderPath: string;
  recordedAt: string;
  duration: string;
  channelContext: string;
  template: { title: string; description: string; tags: string[] };
  recentTitles: string[];
};

/** Models that accept the server-side refusal fallback. */
const FALLBACK_MODELS = new Set(["claude-opus-5-5", "claude-sonnet-5-5"]);

const SYSTEM_PROMPT = `Eres el editor de un canal de YouTube. A partir de los datos de un archivo de video propones el título, la descripción y las etiquetas con las que se va a publicar.

- Escribe en el idioma que indique el contexto del canal; si no indica ninguno, en español.
- Título: máximo 100 caracteres, claro y fiel a los datos. No inventes nombres, lugares ni hechos que no aparezcan en los datos o en el contexto del canal.
- Descripción: pocas frases, salvo que el contexto pida otra cosa. Si el contexto indica textos que siempre deben aparecer (enlaces, redes, horarios), inclúyelos tal cual.
- Etiquetas: entre 5 y 15, cortas y sin "#".
- No uses los caracteres < ni >.
- La propuesta de la plantilla refleja el formato que prefiere el dueño del canal (por ejemplo, numeración o fecha): conserva esa estructura salvo que el contexto diga otra cosa.
- Los títulos recientes muestran el estilo del canal: mantén la coherencia sin repetirlos.`;

export function isAiConfigured(): boolean {
  return Boolean(env().ANTHROPIC_API_KEY);
}

function buildPrompt(input: AiMetadataInput): string {
  const recent = input.recentTitles.length > 0 ? input.recentTitles.map((t) => `- ${t}`).join("\n") : "(ninguno todavía)";
  return `<contexto_del_canal>
${input.channelContext.trim() || "(sin contexto)"}
</contexto_del_canal>

<archivo>
Nombre: ${input.fileName}
Carpeta: ${input.folderPath}
Fecha de grabación: ${input.recordedAt}
Duración: ${input.duration || "desconocida"}
</archivo>

<propuesta_de_plantilla>
Título: ${input.template.title}
Descripción: ${input.template.description || "(vacía)"}
Etiquetas: ${input.template.tags.join(", ") || "(ninguna)"}
</propuesta_de_plantilla>

<titulos_recientes>
${recent}
</titulos_recientes>

Propón el título, la descripción y las etiquetas para este video.`;
}

export async function generateWithAi(input: AiMetadataInput, model: string): Promise<AiMetadata> {
  const apiKey = env().ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY no está configurada");
  const client = new Anthropic({ apiKey, timeout: 120_000 });

  // `create` rather than `parse`: a refusal comes back with partial text, and
  // the stop reason must be checked before attempting to parse it.
  const response = await client.beta.messages.create({
    model,
    max_tokens: 4000,
    ...(FALLBACK_MODELS.has(model) ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
    // Short creative task: low effort keeps it fast and cheap.
    output_config: { effort: "low", format: betaZodOutputFormat(MetadataSchema) },
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: buildPrompt(input) }],
  });

  if (response.stop_reason === "refusal") throw new Error("Claude no generó una propuesta para este video");
  if (response.stop_reason === "max_tokens") throw new Error("La respuesta de Claude quedó incompleta");
  const text = response.content.find((block) => block.type === "text")?.text ?? "";
  let parsed;
  try {
    parsed = MetadataSchema.safeParse(JSON.parse(text));
  } catch {
    parsed = null;
  }
  if (!parsed?.success) throw new Error("La respuesta de Claude no tiene el formato esperado");
  return parsed.data;
}
