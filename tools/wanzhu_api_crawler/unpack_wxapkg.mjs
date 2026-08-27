import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

function usage() {
  console.error("Usage: node unpack_wxapkg.mjs <wxid> <input.wxapkg> <output-dir>");
  process.exit(2);
}

const [, , wxid, inputPath, outputDir] = process.argv;
if (!wxid || !inputPath || !outputDir) usage();
if (!/^wx[0-9a-f]{16}$/.test(wxid)) {
  throw new Error(`Invalid wxid: ${wxid}`);
}

function decryptWxapkg(id, encrypted) {
  if (encrypted.subarray(0, 6).toString("ascii") !== "V1MMWX") {
    return encrypted;
  }
  if (encrypted.length < 1030) {
    throw new Error("Encrypted wxapkg is too short.");
  }

  const key = crypto.pbkdf2Sync(id, "saltiest", 1000, 32, "sha1");
  const decipher = crypto.createDecipheriv(
    "aes-256-cbc",
    key,
    Buffer.from("the iv: 16 bytes", "ascii"),
  );
  decipher.setAutoPadding(false);
  const firstBlock = Buffer.concat([
    decipher.update(encrypted.subarray(6, 1030)),
    decipher.final(),
  ]);

  const xorKey = id.length >= 2 ? id.charCodeAt(id.length - 2) : 0x66;
  const tail = Buffer.allocUnsafe(encrypted.length - 1030);
  for (let i = 1030; i < encrypted.length; i += 1) {
    tail[i - 1030] = encrypted[i] ^ xorKey;
  }

  return Buffer.concat([firstBlock.subarray(0, 1023), tail]);
}

function safeOutputPath(root, packageName) {
  const normalizedName = packageName.replaceAll("\\", "/").replace(/^\/+/, "");
  const destination = path.resolve(root, normalizedName);
  const normalizedRoot = `${path.resolve(root)}${path.sep}`;
  if (!destination.startsWith(normalizedRoot)) {
    throw new Error(`Unsafe package path: ${packageName}`);
  }
  return destination;
}

function unpackPackage(data, root) {
  if (data.length < 18 || data[0] !== 0xbe || data[13] !== 0xed) {
    throw new Error("Decrypted data does not have a valid wxapkg header.");
  }

  const fileCount = data.readUInt32BE(14);
  if (fileCount > 102400) {
    throw new Error(`Unreasonable file count: ${fileCount}`);
  }

  let cursor = 18;
  const entries = [];
  for (let i = 0; i < fileCount; i += 1) {
    const nameLength = data.readUInt32BE(cursor);
    cursor += 4;
    if (nameLength > 4096 || cursor + nameLength + 8 > data.length) {
      throw new Error(`Invalid filename length at entry ${i}: ${nameLength}`);
    }
    const name = data.subarray(cursor, cursor + nameLength).toString("utf8");
    cursor += nameLength;
    const offset = data.readUInt32BE(cursor);
    cursor += 4;
    const size = data.readUInt32BE(cursor);
    cursor += 4;
    if (offset + size > data.length) {
      throw new Error(`Entry outside package bounds: ${name}`);
    }
    entries.push({ name, offset, size });
  }

  fs.mkdirSync(root, { recursive: true });
  for (const entry of entries) {
    const destination = safeOutputPath(root, entry.name);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(
      destination,
      data.subarray(entry.offset, entry.offset + entry.size),
    );
  }
  return entries;
}

const encrypted = fs.readFileSync(inputPath);
const decrypted = decryptWxapkg(wxid, encrypted);
const entries = unpackPackage(decrypted, outputDir);
console.log(JSON.stringify({
  input: path.resolve(inputPath),
  output: path.resolve(outputDir),
  encrypted: encrypted.subarray(0, 6).toString("ascii") === "V1MMWX",
  files: entries.length,
}, null, 2));
