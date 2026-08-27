#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";

const source = path.resolve("web", "expert-tracker", "embed.css");
const destination = path.resolve("web", "expert-tracker", "embed.scoped.css");
const lines = (await fs.readFile(source, "utf8")).split(/\r?\n/);

function scoped(selector) {
  const value = selector.trim();
  if (value === ":root" || value === ".tracker-embed") return ".tracker-embed";
  if (value === "*") return ".tracker-embed, .tracker-embed *";
  if (value === "body") return ".tracker-embed";
  if (value.startsWith(".tracker-embed")) return value;
  return `.tracker-embed ${value}`;
}

const output = lines.map((line) => {
  const trimmed = line.trim();
  if (!trimmed || trimmed === "}") return line;
  if (trimmed.startsWith("@media")) {
    const match = trimmed.match(/^(@media[^{}]+\{)\s*(.*)\s*\}$/);
    if (!match) return line;
    const body = match[2].replace(/(^|})([^{}]+)\{/g, (_whole, boundary, selectorText) => {
      const selectors = selectorText.split(",").map(scoped).join(",");
      return `${boundary}${selectors}{`;
    });
    return `${match[1]} ${body} }`;
  }
  if (trimmed.startsWith("@")) return line;
  const brace = line.indexOf("{");
  if (brace < 0) return line;
  const selectors = line.slice(0, brace).split(",").map(scoped).join(",");
  return `${selectors} ${line.slice(brace)}`;
}).join("\n");

await fs.writeFile(destination, `${output.trim()}\n`, "utf8");
console.log(destination);
