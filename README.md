# OOI Video Sync

Sincroniza videos de **OneDrive** a **YouTube** con un dashboard para revisar, nombrar y seguir cada subida.

- Vincula una o varias cuentas de OneDrive (personales o de trabajo) y canales de YouTube por OAuth.
- Cada **workflow** vigila una carpeta de OneDrive y sube sus videos nuevos a un canal.
- El título, la descripción y las etiquetas salen de **plantillas** (`{filename}`, `{date}`, `{n}`…) o los propone **Claude** con el contexto de tu canal.
- Modo **revisión** (apruebas cada video desde el dashboard) o **automático**.
- Las descargas y subidas se **reanudan** si algo se corta, y el worker respeta la **cuota diaria** de YouTube.

## Cómo funciona

Dos procesos comparten una base SQLite en `DATA_DIR`:

| Proceso | Comando | Qué hace |
| --- | --- | --- |
| Web | `pnpm start` | Dashboard, login y callbacks de OAuth |
| Worker | `pnpm worker:start` | Revisa carpetas, genera títulos, descarga, sube y sigue el procesamiento |

Ciclo de un video:

```
detectado → (por revisar) → en cola → descargando → subiendo → procesando en YouTube → publicado
                                         ↘ error (reintentable) · esperando cuota · ignorado
```

- **Detectado**: el archivo apareció en la carpeta. Se espera a que lleve unos minutos sin cambios (configurable) para no subir algo que aún se sincroniza.
- **Por revisar**: solo en modo revisión. Editas el título y lo apruebas.
- **Esperando cuota**: la cuota diaria se agotó; se reintenta solo después de la medianoche del Pacífico.
- Si una cuenta pierde el acceso, sus workflows se pausan. Al reconectarla, los videos afectados se reintentan solos.

## Requisitos

- Node.js 22 o superior y pnpm.
- Herramientas para compilar `better-sqlite3`: `build-essential` y `python3` (en Debian/Ubuntu: `sudo apt install build-essential python3`).
- Espacio en disco para los archivos temporales: cada transferencia ocupa el tamaño del video mientras dura.

## 1. Configuración externa

### Microsoft (OneDrive)

1. En [Microsoft Entra → App registrations](https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade), crea una aplicación.
   - *Supported account types*: **Accounts in any organizational directory and personal Microsoft accounts**.
   - *Redirect URI* (plataforma **Web**): `https://TU-DOMINIO/api/auth/microsoft/callback`; en local, `http://localhost:3000/api/auth/microsoft/callback`.
2. En **Certificates & secrets**, crea un *client secret*.
3. En **API permissions**, agrega los permisos delegados de Microsoft Graph `Files.ReadWrite`, `offline_access` y `User.Read`.
4. Copia el *Application (client) ID* a `MS_CLIENT_ID` y el secreto a `MS_CLIENT_SECRET`.

### Google (YouTube)

1. En [Google Cloud Console](https://console.cloud.google.com/), crea un proyecto y habilita **YouTube Data API v3**.
2. Configura la **pantalla de consentimiento OAuth** como *External* y agrega el scope `.../auth/youtube`.
3. Crea credenciales **OAuth client ID** de tipo *Web application* con el redirect URI `https://TU-DOMINIO/api/auth/google/callback` (y el de `localhost` si pruebas en local).
4. Copia el ID y el secreto a `GOOGLE_CLIENT_ID` y `GOOGLE_CLIENT_SECRET`.
5. **Publica la app** (*Publishing status → In production*). En modo *Testing*, Google invalida los refresh tokens a los 7 días y tendrías que reconectar el canal cada semana.

> ⚠️ **Videos privados y cuota.** Los proyectos que no pasaron la [auditoría de YouTube API Services](https://support.google.com/youtube/contact/yt_api_form) solo pueden subir videos **privados**: YouTube ignora la privacidad pedida (la app te avisa cuando pasa). La cuota por defecto es de 10 000 unidades diarias. El costo de cada subida aparece distinto según la fuente, así que verifícalo en *APIs → YouTube Data API v3 → Quotas* y ajústalo en **Ajustes** del dashboard.

### Anthropic (opcional)

Para que Claude proponga títulos y descripciones, crea una API key en [platform.claude.com](https://platform.claude.com/) y guárdala en `ANTHROPIC_API_KEY`. Sin ella, la app funciona solo con plantillas.

## 2. Instalación local

```bash
pnpm install
cp .env.example .env
openssl rand -base64 48   # pega el resultado en ENCRYPTION_KEY
openssl rand -base64 48   # y otro distinto en SESSION_SECRET
pnpm hash-password        # pega la línea ADMIN_PASSWORD_HASH=… en .env
```

Completa las credenciales de Microsoft y Google en `.env` y levanta los dos procesos, cada uno en su terminal:

```bash
pnpm dev       # dashboard en http://localhost:3000
pnpm worker    # worker (se reinicia al cambiar el código)
```

La base de datos y sus migraciones se crean solas en `DATA_DIR` (por defecto `./data`).

> **No pierdas `ENCRYPTION_KEY`.** Los tokens OAuth se guardan cifrados con ella; si cambia, tendrás que reconectar todas las cuentas.

## 3. Uso

1. **Cuentas**: conecta OneDrive y el canal de YouTube. Si tienes varios canales, conecta cada uno y elige el canal en la pantalla de Google.
2. **Workflows → Nuevo**: elige la carpeta de OneDrive y el canal, la privacidad, la categoría y la playlist, el modo y las plantillas. La vista previa muestra el resultado con un nombre de archivo de ejemplo.
   - Por defecto se ignoran los videos que **ya estaban** en la carpeta; activa *Procesar los videos que ya están en la carpeta* si quieres subirlos también.
   - *Después de subir* puede mover el archivo a otra carpeta de OneDrive.
3. **Videos**: revisa, edita y aprueba. Las acciones en lote permiten aprobar, reintentar, regenerar el título, ignorar o restaurar. Si editas un video que ya está en YouTube, el cambio se sincroniza allá.

Variables de las plantillas:

| Variable | Resultado |
| --- | --- |
| `{filename}` | Nombre sin extensión; `_` y `-` se convierten en espacios |
| `{original_name}` | Nombre exacto del archivo |
| `{date}` | Fecha de grabación, `dd/MM/yyyy` |
| `{date:FORMATO}` | Fecha con formato de [date-fns](https://date-fns.org/docs/format), p. ej. `{date:EEEE d 'de' MMMM}` → `domingo 10 de mayo` |
| `{folder}` | Nombre de la carpeta |
| `{n}` | Número consecutivo del workflow |
| `{duration}` | Duración (`h:mm:ss`) |

La fecha de grabación sale del nombre del archivo cuando trae una fecha (`VID_20260510_120000.mp4`, `2026-05-10 Misa.mov`). Si no trae, se usa la fecha de creación del archivo.

## 4. Producción en un VPS

```bash
git clone … /opt/ooi-video-sync && cd /opt/ooi-video-sync
pnpm install --frozen-lockfile
cp .env.example .env   # complétalo; APP_URL debe ser la URL pública con https
pnpm build
```

- **Procesos**: copia `deploy/ovs-web.service` y `deploy/ovs-worker.service` a `/etc/systemd/system/` y ajusta `User`, `WorkingDirectory` y la ruta de `pnpm` (`which pnpm`). Después ejecuta `sudo systemctl enable --now ovs-web ovs-worker`. Corre **un solo worker** por base de datos.
- **HTTPS**: los redirect URIs de OAuth necesitan HTTPS fuera de `localhost`. `deploy/Caddyfile` es un ejemplo de proxy inverso con certificado automático.
- **Respaldos**: `pnpm backup` hace un respaldo en caliente de la base en `DATA_DIR/backups` y conserva los últimos 14. Para hacerlo cada día, instala `deploy/ovs-backup.service` y `deploy/ovs-backup.timer`.
- **Actualizar**: `git pull && pnpm install && pnpm build && sudo systemctl restart ovs-web ovs-worker`. Las migraciones se aplican solas al arrancar.

## Scripts

| Comando | Para qué |
| --- | --- |
| `pnpm dev` / `pnpm worker` | Desarrollo |
| `pnpm build` / `pnpm start` / `pnpm worker:start` | Producción |
| `pnpm test` | Tests (vitest) |
| `pnpm typecheck` / `pnpm lint` | Tipos y lint |
| `pnpm db:generate` | Generar una migración después de cambiar `src/server/db/schema.ts` |
| `pnpm hash-password` | Generar `ADMIN_PASSWORD_HASH` |
| `pnpm backup` | Respaldar la base de datos |

## Estructura

```
src/app/            dashboard (Next.js App Router) y rutas de OAuth
src/server/         lógica compartida por la web y el worker
  db/               esquema Drizzle y conexión SQLite
  providers/        OAuth, Microsoft Graph y YouTube Data API (subida resumable)
  naming/           plantillas, límites de YouTube e IA
  jobs/             cola, planificador y handlers del pipeline
src/worker/         proceso worker
drizzle/            migraciones SQL
deploy/             systemd y Caddy
tests/              tests
```
