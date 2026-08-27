import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const path = join(dirname(dirname(fileURLToPath(import.meta.url))), ".env");
if (existsSync(path) && typeof process.loadEnvFile === "function") process.loadEnvFile(path);
