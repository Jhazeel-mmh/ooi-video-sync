# OOI Video Sync

Sincroniza videos de **OneDrive** a **YouTube** con un dashboard para revisar, nombrar y seguir cada subida.

- Vincula una o varias cuentas de OneDrive (personales o de trabajo) y canales de YouTube por OAuth.
- Cada **workflow** vigila una carpeta de OneDrive y sube sus videos nuevos a un canal.
- **Filtros acumulables** por fecha de grabación, tamaño, duración y palabras en el nombre, y **omisión de duplicados**.
- El título, la descripción y las etiquetas salen de **plantillas** (`{filename}`, `{date}`, `{n}`…) o los propone la IA (**Claude** o **Gemini**, que tiene capa gratuita) con el contexto de tu canal.
- Opcionalmente, Gemini **transcribe el audio** para que la IA titule según lo que se dice en el video, y se agregan **capítulos** a la descripción.
- Modo **revisión** (apruebas cada video desde el dashboard) o **automático**.
- Las descargas y subidas se **reanudan** si algo se corta, y el worker respeta la **cuota diaria** de YouTube.
- **Avisos a Discord** cuando un video se publica, falla o hay videos por revisar.

## Cómo funciona

Dos procesos comparten una base SQLite en `DATA_DIR`:

| Proceso | Comando | Qué hace |
| --- | --- | --- |
| Web | `pnpm start` | Dashboard, login y callbacks de OAuth |
| Worker | `pnpm worker:start` | Revisa carpetas, aplica filtros, transcribe, genera títulos, descarga, sube, sigue el procesamiento y manda los avisos |

Ciclo de un video:

```
detectado → preparación → (por revisar) → en cola → descargando → subiendo → procesando en YouTube → publicado
                 ↘ ignorado (filtro o duplicado)         ↘ error (reintentable) · esperando cuota
```

- **Detectado**: el archivo apareció en la carpeta. Se espera a que lleve unos minutos sin cambios (configurable) para no subir algo que aún se sincroniza.
- **Preparación**: se revisan los filtros con el tamaño y la duración definitivos, se descartan duplicados y, si el workflow lo pide, se transcribe el audio y se genera el título.
- **Por revisar**: solo en modo revisión. Editas el título y lo apruebas.
- **Esperando cuota**: la cuota diaria se agotó; se reintenta solo después de la medianoche del Pacífico.
- Si una cuenta pierde el acceso, sus workflows se pausan. Al reconectarla, los videos afectados se reintentan solos.

## Requisitos

- Node.js 22 o superior y pnpm.
- Herramientas para compilar `better-sqlite3`: `build-essential` y `python3` (en Debian/Ubuntu: `sudo apt install build-essential python3`).
- Espacio en disco para los archivos temporales: cada transferencia ocupa el tamaño del video mientras dura.
- ffmpeg viene incluido (paquete `ffmpeg-static`); se usa para medir duraciones y extraer el audio. Si prefieres el del sistema, pon su ruta en `FFMPEG_PATH`.

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

### IA: Gemini y/o Claude (opcional)

Sin ninguna key, la app funciona solo con plantillas.

- **Gemini (gratis)**: entra a [Google AI Studio → API keys](https://aistudio.google.com/apikey), crea una key (puedes usar el mismo proyecto de Google Cloud) y guárdala en `GEMINI_API_KEY`. Sin facturación activa usas la capa gratuita de `gemini-3.8-flash` y `gemini-3.5-flash-lite`.
  - ⚠️ En la capa gratuita **Google usa lo que le envías (incluido el audio) para mejorar sus productos**.
  - Sus límites por minuto y por día solo se ven en AI Studio. Cuando la app choca con un límite, reintenta el video más tarde.
- **Claude**: crea una key en [platform.claude.com](https://platform.claude.com/) y guárdala en `ANTHROPIC_API_KEY`.
- **Quién genera los títulos**: en modo *Automático* (por defecto) se usa Claude si hay `ANTHROPIC_API_KEY` y, si no, Gemini. En **Ajustes** puedes fijar uno y elegir el modelo de cada proveedor.
- **La transcripción siempre usa Gemini**, porque la API de Claude no acepta audio: hace falta `GEMINI_API_KEY` aunque los títulos los haga Claude.

## 2. Instalación local

```bash
pnpm install
cp .env.example .env
openssl rand -base64 48   # pega el resultado en ENCRYPTION_KEY
openssl rand -base64 48   # y otro distinto en SESSION_SECRET
pnpm hash-password        # pega la línea ADMIN_PASSWORD_HASH=… en .env
```

Completa en `.env` las credenciales de Microsoft y Google y, si vas a usar IA, `GEMINI_API_KEY` y/o `ANTHROPIC_API_KEY`. Luego levanta los dos procesos, cada uno en su terminal:

```bash
pnpm dev       # dashboard en http://localhost:3000
pnpm worker    # worker (se reinicia al cambiar el código)
```

La base de datos y sus migraciones se crean solas en `DATA_DIR` (por defecto `./data`). Si cambias el `.env`, reinicia los dos procesos: ninguno lo vuelve a leer en caliente.

> **No pierdas `ENCRYPTION_KEY`.** Los tokens OAuth se guardan cifrados con ella; si cambia, tendrás que reconectar todas las cuentas.

## 3. Uso

1. **Cuentas**: conecta OneDrive y el canal de YouTube. Si tienes varios canales, conecta cada uno y elige el canal en la pantalla de Google.
2. **Workflows → Nuevo**: elige la carpeta de OneDrive y el canal, la privacidad, la categoría y la playlist, el modo y las plantillas. La vista previa muestra el resultado con un nombre de archivo de ejemplo.
   - *Procesar los videos que ya están en la carpeta*: si está apagado, solo se procesan los que lleguen después de crear el workflow.
   - *Filtros* (opcionales y acumulables; un video se procesa solo si cumple todos):
     - fecha de grabación desde y/o hasta;
     - tamaño mínimo y/o máximo;
     - duración mínima y/o máxima (si OneDrive no la informa, se mide con ffmpeg leyendo solo el encabezado del archivo);
     - el nombre contiene alguna de ciertas palabras y/o no contiene ninguna de otras (sin distinguir mayúsculas ni acentos);
     - omitir duplicados: si el mismo archivo ya se subió o está aprobado en cualquier workflow, no se sube de nuevo.

     El formulario muestra un resumen de lo que se va a procesar. Si cambias los filtros o la opción anterior en un workflow existente, se recuperan los videos que se habían ignorado por esas reglas y ahora las cumplen, y se excluyen los pendientes que ya no. Los que ignoraste a mano no se tocan.
   - *Generar con IA*, con el contexto de tu canal (tono, idioma, textos fijos para la descripción).
   - *Usar la transcripción del audio*: antes de nombrar, ffmpeg extrae el audio leyendo el video desde OneDrive sin guardarlo, Gemini lo transcribe en tramos de 30 minutos (en Ajustes puedes limitar cuántos minutos transcribir) y la IA usa ese texto como fuente principal. La transcripción se ve en la página de cada video, y ahí también se puede transcribir a mano.
   - *Agregar capítulos*: la IA divide el video en partes con las marcas de tiempo de la transcripción y se agregan a la descripción con el formato que YouTube reconoce (empieza en 00:00, al menos 3 capítulos de 10 segundos o más).
   - *Después de subir* puede mover el archivo a otra carpeta de OneDrive.
3. **Videos**: revisa, edita y aprueba. Las acciones en lote permiten aprobar, reintentar, regenerar el título, ignorar o restaurar. Si editas un video que ya está en YouTube, el cambio se sincroniza allá.
4. **Avisos a Discord** (opcional): en Discord ve a *Ajustes del canal → Integraciones → Webhooks → Nuevo webhook* y copia la URL. Pégala en **Ajustes → Avisos a Discord** y usa *Enviar prueba*. Llega un mensaje cuando un video se publica o falla, cuando una cuenta necesita reconectarse, y uno agrupado (como máximo cada 30 minutos por workflow) cuando hay videos nuevos por revisar.

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
  naming/           plantillas, límites de YouTube, transcripción, capítulos
    ai/             Claude y Gemini (prompt común)
  media/            ffmpeg: duración y extracción de audio
  jobs/             cola, planificador y handlers del pipeline
  filters.ts        filtros de los workflows (puro, también lo usa el formulario)
  video-scope.ts    qué videos se procesan: filtros, duplicados, reevaluación
  notify.ts         avisos a Discord
src/worker/         proceso worker
drizzle/            migraciones SQL
deploy/             systemd y Caddy
tests/              tests
```

## Problemas frecuentes

| Síntoma | Causa y solución |
| --- | --- |
| Google muestra `Error 403: access_denied` | La app de Google sigue en modo *Testing* y tu cuenta no es usuario de prueba. Publícala (*Google Auth Platform → Público → Publicar app*) o agrégate como tester. |
| `redirect_uri_mismatch` | El redirect URI registrado debe ser exactamente `APP_URL` + `/api/auth/<proveedor>/callback` (revisa http/https, el puerto y que no sobre una `/`). |
| El inicio dice "El worker no está corriendo" | Inicia `pnpm worker` (o el servicio `ovs-worker`). Sin él no se detecta ni se sube nada. |
| Los videos subidos quedan privados | El proyecto de Google Cloud no pasó la auditoría de YouTube API Services; ver la sección de Google. |
| Videos en "Esperando cuota" | Se agotó la cuota diaria de YouTube; se reanudan solos después de la medianoche del Pacífico. Ajusta los valores reales en **Ajustes**. |
| "Gemini: límite de uso alcanzado" en el historial | Límite de la capa gratuita; el video se reintenta más tarde solo. |
| La transcripción no está disponible | Falta `GEMINI_API_KEY` en `.env` (o ffmpeg, si usas `FFMPEG_PATH`). Reinicia los procesos después de editar `.env`. |
