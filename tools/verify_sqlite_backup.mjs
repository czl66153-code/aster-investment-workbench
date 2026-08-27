import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

const path = resolve(process.argv[2] || "");
const database = new DatabaseSync(path, { readOnly: true });
const integrity = database.prepare("PRAGMA integrity_check").get()?.integrity_check;
database.close();
if (integrity !== "ok") throw new Error(`backup integrity check failed: ${integrity}`);
const checksum = createHash("sha256").update(readFileSync(path)).digest("hex");
console.log(JSON.stringify({ ok: true, path, size: statSync(path).size, checksum, integrity }));
