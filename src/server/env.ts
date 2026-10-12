import { z } from "zod";

const optional = z
  .string()
  .optional()
  .transform((v) => (v ? v : undefined));

const schema = z.object({
  APP_URL: z.url().default("http://localhost:3000"),
  DATA_DIR: z.string().default("./data"),
  ENCRYPTION_KEY: z.string().min(32, "ENCRYPTION_KEY debe tener al menos 32 caracteres"),
  SESSION_SECRET: z.string().min(32, "SESSION_SECRET debe tener al menos 32 caracteres"),
  ADMIN_PASSWORD_HASH: z.string().startsWith("scrypt:", "Genera el hash con `pnpm hash-password`"),
  MS_CLIENT_ID: optional,
  MS_CLIENT_SECRET: optional,
  GOOGLE_CLIENT_ID: optional,
  GOOGLE_CLIENT_SECRET: optional,
  ANTHROPIC_API_KEY: optional,
});

export type Env = z.infer<typeof schema>;

let cached: Env | undefined;

/** Parsed lazily so `next build` doesn't require runtime secrets. */
export function env(): Env {
  if (!cached) {
    const result = schema.safeParse(process.env);
    if (!result.success) {
      const issues = result.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
      throw new Error(`Variables de entorno inválidas:\n${issues}`);
    }
    cached = result.data;
  }
  return cached;
}

export function isSecureOrigin(): boolean {
  return env().APP_URL.startsWith("https://");
}
