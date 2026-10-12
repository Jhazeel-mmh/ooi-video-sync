import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Each test file gets its own throwaway database.
process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "ovs-test-"));
process.env.ENCRYPTION_KEY = "test-encryption-key-test-encryption-key";
process.env.SESSION_SECRET = "test-session-secret-test-session-secret";
process.env.ADMIN_PASSWORD_HASH = "scrypt:c2FsdA==:aGFzaA==";
