import { z } from "zod";

/** Long transcripts are cut to keep requests fast and within free-tier limits. */
const MAX_TRANSCRIPT_CHARS = 40_000;

export type AiMetadataInput = {
  fileName: string;
  folderPath: string;
  recordedAt: string;
  duration: string;
  channelContext: string;
  template: { title: string; description: string; tags: string[] };
  recentTitles: string[];
  /** Transcript with `[h:mm:ss]` marks, when available. */
  transcript?: string | null;
  /** Ask for YouTube chapters (needs a transcript). */
  chapters?: boolean;
};

const chapterSchema = z.object({
  start: z.string().describe("Inicio del capítulo en formato h:mm:ss, tomado de las marcas de la transcripción"),
  title: z.string().describe("Título corto del capítulo"),
});

const baseSchema = z.object({
  title: z.string().describe("Título del video, máximo 100 caracteres"),
  description: z.string().describe("Descripción del video, sin la lista de capítulos"),
  tags: z.array(z.string()).describe("Etiquetas, sin #"),
});

const withChaptersSchema = baseSchema.extend({
  chapters: z.array(chapterSchema).describe("Capítulos en orden; el primero empieza en 0:00:00"),
});

export type AiChapter = z.infer<typeof chapterSchema>;
export type AiMetadata = z.infer<typeof baseSchema> & { chapters?: AiChapter[] };

export function metadataSchema(chapters: boolean) {
  return chapters ? withChaptersSchema : baseSchema;
}

export const SYSTEM_PROMPT = `Eres el editor de un canal de YouTube. A partir de los datos de un archivo de video propones el título, la descripción y las etiquetas con las que se va a publicar.

- Escribe en el idioma que indique el contexto del canal; si no indica ninguno, en español.
- Título: máximo 100 caracteres, claro y fiel a los datos. No inventes nombres, lugares ni hechos que no aparezcan en los datos, la transcripción o el contexto del canal.
- Descripción: pocas frases, salvo que el contexto pida otra cosa. Si el contexto indica textos que siempre deben aparecer (enlaces, redes, horarios), inclúyelos tal cual.
- Etiquetas: entre 5 y 15, cortas y sin "#".
- No uses los caracteres < ni >.
- La propuesta de la plantilla refleja el formato que prefiere el dueño del canal (por ejemplo, numeración o fecha): conserva esa estructura salvo que el contexto diga otra cosa.
- Los títulos recientes muestran el estilo del canal: mantén la coherencia sin repetirlos.
- Si hay transcripción, úsala para entender de qué trata el video; es la mejor fuente para el título y la descripción.`;

const CHAPTERS_INSTRUCTION = `
- Capítulos: divide el video en las partes que realmente cambian de tema (al menos 3), usando las marcas de tiempo de la transcripción. El primero empieza en 0:00:00. No pongas la lista de capítulos dentro de la descripción.`;

export function systemPrompt(chapters: boolean): string {
  return chapters ? SYSTEM_PROMPT + CHAPTERS_INSTRUCTION : SYSTEM_PROMPT;
}

export function buildPrompt(input: AiMetadataInput): string {
  const recent = input.recentTitles.length > 0 ? input.recentTitles.map((t) => `- ${t}`).join("\n") : "(ninguno todavía)";
  const transcript = input.transcript?.trim();
  const transcriptBlock = transcript
    ? `

<transcripcion>
${transcript.length > MAX_TRANSCRIPT_CHARS ? `${transcript.slice(0, MAX_TRANSCRIPT_CHARS)}\n[…transcripción recortada…]` : transcript}
</transcripcion>`
    : "";
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
</titulos_recientes>${transcriptBlock}

Propón el título, la descripción y las etiquetas para este video${input.chapters ? ", y sus capítulos" : ""}.`;
}
