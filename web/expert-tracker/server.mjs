#!/usr/bin/env node

import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";

const root = import.meta.dirname;
const port = Number(process.env.EXPERT_TRACKER_PORT || 4178);
const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

const server = http.createServer(async (request, response) => {
  try {
    const requestPath = decodeURIComponent(new URL(request.url, `http://${request.headers.host}`).pathname);
    const modulePath = requestPath.startsWith("/expert-tracker/")
      ? requestPath.slice("/expert-tracker".length)
      : requestPath;
    const normalized = modulePath === "/" ? "/index.html" : modulePath;
    const file = path.resolve(root, `.${normalized}`);
    if (!file.startsWith(root)) throw new Error("Forbidden");
    const body = await fs.readFile(file);
    response.writeHead(200, {
      "content-type": types[path.extname(file)] || "application/octet-stream",
      "cache-control": "no-store",
    });
    response.end(body);
  } catch {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Expert tracker: http://127.0.0.1:${port}`);
});
