import { loadEnvConfig } from "@next/env";

// Same .env resolution as `next dev` / `next start`. Imported first by the worker.
loadEnvConfig(process.cwd(), process.env.NODE_ENV !== "production");
