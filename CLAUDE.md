@AGENTS.md

# OOI Video Sync

Sincroniza videos de OneDrive a YouTube. Dashboard en Next.js 16 (App Router) + un proceso worker, ambos sobre la misma base SQLite. Un solo administrador. El README explica la configuración y el uso; aquí va lo que hace falta para trabajar en el código.

## Comandos

- `pnpm dev` y `pnpm worker`: desarrollo, cada uno en su terminal. `pnpm worker` es `tsx watch`: se reinicia con cada archivo importado que cambia (no con `drizzle/*.sql` ni con `.env`).
- `pnpm test`: vitest. `pnpm typecheck`: corre `next typegen` + `tsc`. `pnpm lint`. `pnpm build`.
- `pnpm db:generate --name <nombre>`: migración nueva a partir de `src/server/db/schema.ts`.
- Antes de dar algo por terminado: `pnpm typecheck && pnpm lint && pnpm test` (y `pnpm build` si tocaste páginas o configuración).

## Arquitectura

- `src/app/`: páginas (UI en español). Las mutaciones son Server Actions en `actions.ts` junto a cada página, devuelven `ActionResult` (`src/lib/action-result.ts`) y llaman a `refresh()` de `next/cache`.
- `src/server/`: lógica compartida por la web y el worker.
- `src/worker/index.ts`: claim de jobs, concurrencia (transferencias aparte), planificador cada 30 s (escaneos, locks vencidos, avisos agrupados, latido) y apagado ordenado.
- Pipeline de un video:
  1. `scan_workflow` lo detecta.
  2. `generate_metadata` lo prepara: filtros con datos finales, duplicados, transcripción y título.
  3. `transfer_video` lo sube.
  4. `check_processing` espera el procesamiento de YouTube.

  Además: `sync_metadata` (ediciones posteriores) y `transcribe_video` (bajo demanda).
- La cola (`src/server/jobs/queue.ts`) vive en SQLite. Para un tipo de job nuevo:
  1. Agrégalo a `JOB_TYPES` (schema).
  2. Agrega su payload a `JobPayloads` (queue).
  3. Registra su handler en `runner.ts`.
  4. Si falla, el video no debería cambiar de estado: agrega un caso en `onVideoJobFailure`.
- Los handlers comunican qué hacer lanzando errores tipados de `src/server/errors.ts`: `RetryableError` (reintento con backoff), `PermanentError` y `AuthError` (sin reintento), `QuotaError` (reprograma hasta la cuota siguiente), `RescheduleSignal` (vuelve a correr sin contar intento). `JobContext` trae `signal`, `attempt` y `maxAttempts` (`canRetry`).
- Un video ignorado siempre guarda `ignoredReason`. Solo los motivos automáticos (`existing`, `filtered`, `duplicate`) se reevalúan cuando cambian los filtros, en `reapplyVideoScope`. `manual` y `missing` no se tocan.

## Convenciones y trampas

- **Next 16 con `cacheComponents`**: todo lo que lee cookies, la base o la hora va dentro de `<Suspense>`, en un componente async que empieza con `await requireAdmin()` (que hace `await io()`). `better-sqlite3` es síncrono, así que sin eso la consulta terminaría en el prerender. Antes de usar una API de Next, revisa `node_modules/next/dist/docs/`.
- **Lint `react-hooks/purity`**: nada de `Date.now()`/`new Date()` en el cuerpo de un componente. Mueve esa lógica a una función normal (ver `loadOverview` en `src/app/(dashboard)/page.tsx`).
- **Imports dentro de `src/server/`**: son relativos, porque el worker corre con tsx. `server-only` solo se usa en `session.ts` y `oauth-state.ts`; en cualquier módulo que importe el worker rompería.
- **Módulos puros** (los importan también componentes cliente, así que sin DB, env ni Node): `naming/template.ts`, `naming/sanitize.ts`, `naming/chapters.ts`, `filters.ts`, `lib/format.ts`.
- **Sin dependencias implícitas**: todo paquete importado debe estar en `package.json`. Un `pnpm add` que falla al compilar puede dejar el paquete en `node_modules` sin registrarlo; ya pasó una vez. Los paquetes con scripts de instalación se habilitan en `onlyBuiltDependencies` de `pnpm-workspace.yaml`: `better-sqlite3` necesita `node-gyp` y `ffmpeg-static` descarga el binario.
- **Migraciones**: se aplican solas al abrir la base (`getDb()`). Si cambian datos, agrega el `UPDATE` al final del SQL generado. Con datos reales, pruébala antes sobre una copia de `data/app.db` (backup en caliente con better-sqlite3).
- **IA**:
  - Claude usa `client.beta.messages.create` con `output_config.format`: revisa `stop_reason` antes de parsear, porque `parse` falla con una respuesta rechazada. El modelo por defecto es `claude-opus-5-5`, con `fallbacks: "default"`.
  - Gemini usa `client.interactions.create` de `@google/genai` con `response_format`, `store: false` y `maxRetries: 0`; la respuesta se lee de `output_text`.
  - La transcripción solo puede hacerse con Gemini, porque Claude no acepta audio.
  - Un 429 o un 5xx se convierte en `RetryableError` y la cola reintenta.
- **Proveedores externos** (todo con `fetch`, sin SDKs de Google o Microsoft):
  - Descargas de Graph: el 302 se sigue a mano (`getDownloadUrl`) para no mandar el token al storage.
  - Subida a YouTube: protocolo resumable implementado en `providers/youtube.ts`, con la sesión guardada en `videos.upload_session_url`.
- **Textos**: la UI, los mensajes de error y los commits van en español; los comentarios del código, en inglés.

## Tests

- `tests/setup.ts` crea una base temporal por archivo. `env()` y la conexión quedan cacheadas por archivo, así que pon las variables (`process.env.X`) al inicio del archivo de test.
- `tests/helpers.ts`:
  - `createWorkflow()` crea cuentas falsas con tokens vigentes.
  - `mockFetch()` reemplaza el `fetch` global y también entiende objetos `Request` (los SDKs mandan esos).
  - `json()` arma respuestas.
- Los SDKs capturan `fetch` al construirse; por eso los clientes de Anthropic y Gemini se crean en cada llamada.
- Los tests de medios usan `ffmpeg-static` real con un video generado con `-f lavfi` (ver `tests/prepare.test.ts`).
