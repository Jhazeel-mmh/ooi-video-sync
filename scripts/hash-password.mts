import { createInterface } from "node:readline/promises";
import { hashPassword } from "../src/server/crypto";

const rl = createInterface({ input: process.stdin, output: process.stdout });
const password = await rl.question("Contraseña de administrador: ");
rl.close();
if (password.length < 8) {
  console.error("La contraseña debe tener al menos 8 caracteres.");
  process.exit(1);
}
console.log(`\nADMIN_PASSWORD_HASH=${hashPassword(password)}`);
