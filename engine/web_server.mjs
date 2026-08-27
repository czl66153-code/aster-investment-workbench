import "./env.mjs";
import http from "node:http";
import { brotliCompressSync, constants as zlibConstants, gzipSync } from "node:zlib";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { projectDir } from "./core.mjs";

const port = Number(process.env.ASTER_WEB_PORT || 3100);
const host = process.env.ASTER_WEB_HOST || "127.0.0.1";
const requestHost = host.includes(":") ? `[${host}]` : host;
const engineOrigin = process.env.ASTER_ENGINE_ORIGIN || `http://127.0.0.1:${Number(process.env.ASTER_ENGINE_PORT || 8035)}`;
const assetRoot = resolve(projectDir, "dist", "client");
const expertAssetRoot = resolve(projectDir, "web", "expert-tracker");
const workerPath = join(projectDir, "dist", "server", "index.js");
if (!existsSync(workerPath) || !existsSync(assetRoot)) throw new Error("生产构建不存在，请先运行 npm run build");
if (!existsSync(expertAssetRoot)) throw new Error("高手蒸馏原生资源不存在");

const mimeTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"], [".js", "text/javascript; charset=utf-8"], [".mjs", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"], [".svg", "image/svg+xml"], [".png", "image/png"], [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"], [".webp", "image/webp"], [".woff2", "font/woff2"], [".woff", "font/woff"], [".ico", "image/x-icon"],
]);

function assetPath(pathname) {
  const cleaned = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, "");
  const target = resolve(assetRoot, cleaned);
  return target === assetRoot || target.startsWith(`${assetRoot}\\`) || target.startsWith(`${assetRoot}/`) ? target : null;
}

function expertPath(pathname) {
  if (!pathname.startsWith("/expert-tracker/")) return null;
  const cleaned = normalize(decodeURIComponent(pathname.slice("/expert-tracker/".length))).replace(/^([/\\])+/, "");
  const target = resolve(expertAssetRoot, cleaned);
  return target === expertAssetRoot || target.startsWith(`${expertAssetRoot}\\`) || target.startsWith(`${expertAssetRoot}/`) ? target : null;
}

function isLoopback(request) {
  const address = request.socket?.remoteAddress || "";
  return address === "::1" || address === "127.0.0.1" || address.startsWith("::ffff:127.");
}

const securityHeaders = {
  "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'self'",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "SAMEORIGIN",
};

function assetResponse(input) {
  const url = new URL(typeof input === "string" ? input : input.url);
  const staticPathname = url.pathname === "/favicon.ico" ? "/favicon.svg" : url.pathname;
  const path = assetPath(staticPathname);
  if (!path || !existsSync(path) || !statSync(path).isFile()) return new Response("Not found", { status: 404 });
  return new Response(readFileSync(path), { status: 200, headers: { "content-type": mimeTypes.get(extname(path).toLowerCase()) || "application/octet-stream" } });
}

const { default: worker } = await import(`${pathToFileURL(workerPath).href}?startup=${Date.now()}`);
const htmlPages = new Map();
for (const route of ["/", "/expert-tracker"]) {
  const rendered = await worker.fetch(new Request(`http://${requestHost}:${port}${route}`, { headers: { accept: "text/html" } }), { ASSETS: { fetch: async (request) => assetResponse(request) } }, { waitUntil() {}, passThroughOnException() {} });
  if (!rendered.ok) throw new Error(`${route} 预渲染失败：${rendered.status}`);
  const headers = Object.fromEntries(rendered.headers);
  headers["content-type"] = "text/html; charset=utf-8";
  headers["cache-control"] = "no-cache";
  delete headers["content-length"];
  htmlPages.set(route, { body: Buffer.from(await rendered.arrayBuffer()), headers });
}

const encodedCache = new Map();
function sendAsset(request, response, path) {
  const extension = extname(path).toLowerCase();
  const type = mimeTypes.get(extension) || "application/octet-stream";
  const cacheKey = `${path}|${request.headers["accept-encoding"] || ""}`;
  let cached = encodedCache.get(cacheKey);
  if (!cached) {
    const raw = readFileSync(path);
    const compressible = /^(text\/|application\/(javascript|json))/.test(type) && raw.length > 1024;
    const accepted = request.headers["accept-encoding"] || "";
    let body = raw; let encoding = "";
    if (compressible && accepted.includes("br")) { body = brotliCompressSync(raw, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 5 } }); encoding = "br"; }
    else if (compressible && accepted.includes("gzip")) { body = gzipSync(raw, { level: 6 }); encoding = "gzip"; }
    cached = { body, encoding, type }; encodedCache.set(cacheKey, cached);
  }
  const headers = { "Content-Type": cached.type, "Content-Length": cached.body.length, "Cache-Control": path.includes(`${join("_next", "static")}`) ? "public, max-age=31536000, immutable" : "public, max-age=86400", "X-Content-Type-Options": "nosniff" };
  if (cached.encoding) { headers["Content-Encoding"] = cached.encoding; headers.Vary = "Accept-Encoding"; }
  response.writeHead(200, headers); if (request.method !== "HEAD") response.end(cached.body); else response.end();
}

function sendExpertAsset(request, response, path) {
  const extension = extname(path).toLowerCase();
  const type = mimeTypes.get(extension) || "application/octet-stream";
  const raw = readFileSync(path);
  const isPublishedData = path.startsWith(join(expertAssetRoot, "data"));
  const compressible = /^(text\/|application\/(javascript|json))/.test(type) && raw.length > 1024;
  const accepted = request.headers["accept-encoding"] || "";
  let body = raw; let encoding = "";
  if (compressible && accepted.includes("br")) { body = brotliCompressSync(raw, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 5 } }); encoding = "br"; }
  else if (compressible && accepted.includes("gzip")) { body = gzipSync(raw, { level: 6 }); encoding = "gzip"; }
  const headers = { ...securityHeaders, "Content-Type": type, "Content-Length": body.length, "Cache-Control": isPublishedData ? "no-store" : "public, max-age=3600" };
  if (encoding) { headers["Content-Encoding"] = encoding; headers.Vary = "Accept-Encoding"; }
  response.writeHead(200, headers); if (request.method !== "HEAD") response.end(body); else response.end();
}

async function sendWorkerRoute(request, response, url) {
  const forwardedHeaders = new Headers();
  for (const [key, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) value.forEach((item) => forwardedHeaders.append(key, item));
    else if (value !== undefined) forwardedHeaders.set(key, value);
  }
  const rendered = await worker.fetch(new Request(url.href, { method: request.method, headers: forwardedHeaders }), { ASSETS: { fetch: async (input) => assetResponse(input) } }, { waitUntil() {}, passThroughOnException() {} });
  const body = Buffer.from(await rendered.arrayBuffer());
  const responseHeaders = { ...Object.fromEntries(rendered.headers), ...securityHeaders, "Content-Length": body.length };
  response.writeHead(rendered.status, responseHeaders); if (request.method !== "HEAD") response.end(body); else response.end();
}

async function readRequestBody(request, maximumBytes = 1_500_000) {
  if (["GET", "HEAD"].includes(request.method || "GET")) return undefined;
  const chunks = []; let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maximumBytes) throw new Error("请求体超过本地代理限制");
    chunks.push(chunk);
  }
  return chunks.length ? Buffer.concat(chunks) : undefined;
}

async function proxyEngineRequest(request, response, url) {
  if (!isLoopback(request)) {
    response.writeHead(403, { ...securityHeaders, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    response.end(JSON.stringify({ error: "ASTER 数据接口仅允许本机访问" }));
    return;
  }
  const target = new URL(`${url.pathname}${url.search}`, engineOrigin);
  const forwardedHeaders = new Headers();
  for (const [key, value] of Object.entries(request.headers)) {
    if (["host", "origin", "referer", "content-length", "connection"].includes(key.toLowerCase())) continue;
    if (Array.isArray(value)) value.forEach((item) => forwardedHeaders.append(key, item));
    else if (value !== undefined) forwardedHeaders.set(key, value);
  }
  forwardedHeaders.set("X-Aster-Local-Gateway", "1");
  const body = await readRequestBody(request);
  const upstream = await fetch(target, { method: request.method, headers: forwardedHeaders, body });
  const payload = Buffer.from(await upstream.arrayBuffer());
  const upstreamHeaders = Object.fromEntries(upstream.headers);
  delete upstreamHeaders["access-control-allow-origin"];
  delete upstreamHeaders["content-length"];
  delete upstreamHeaders["transfer-encoding"];
  delete upstreamHeaders.connection;
  delete upstreamHeaders["keep-alive"];
  delete upstreamHeaders.trailer;
  response.writeHead(upstream.status, { ...upstreamHeaders, ...securityHeaders, "Cache-Control": "no-store", "Content-Length": payload.length });
  if (request.method !== "HEAD") response.end(payload); else response.end();
}

async function handleRequest(request, response) {
  const url = new URL(request.url || "/", `http://${request.headers.host || `${host}:${port}`}`);
  const expertRequest = url.pathname === "/expert-tracker" || url.pathname === "/expert-tracker/" || url.pathname.startsWith("/expert-tracker/");
  if (expertRequest && !isLoopback(request)) {
    response.writeHead(403, { ...securityHeaders, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }); response.end(JSON.stringify({ allowed: false, error: "高手蒸馏仅允许本机研究员访问" })); return;
  }
  if (url.pathname === "/health" || url.pathname === "/api" || url.pathname.startsWith("/api/")) {
    try { await proxyEngineRequest(request, response, url); }
    catch (error) {
      response.writeHead(502, { ...securityHeaders, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      response.end(JSON.stringify({ error: `独立引擎暂不可用：${error instanceof Error ? error.message : String(error)}` }));
    }
    return;
  }
  if (url.pathname === "/expert-tracker/access-status") { response.writeHead(200, { ...securityHeaders, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }); response.end(JSON.stringify({ allowed: true, scope: "local_operator", route: "/expert-tracker" })); return; }
  const isRscRequest = request.headers.rsc === "1" || Boolean(request.headers["next-router-state-tree"]) || url.searchParams.has("_rsc");
  if (isRscRequest && (url.pathname === "/" || url.pathname === "/expert-tracker" || url.pathname === "/expert-tracker/")) { await sendWorkerRoute(request, response, url); return; }
  const route = url.pathname === "/expert-tracker/" ? "/expert-tracker" : url.pathname === "/index.html" ? "/" : url.pathname;
  if (htmlPages.has(route)) { const page = htmlPages.get(route); response.writeHead(200, { ...page.headers, ...securityHeaders, "Content-Length": page.body.length }); if (request.method !== "HEAD") response.end(page.body); else response.end(); return; }
  const expertAsset = expertPath(url.pathname);
  if (expertAsset && existsSync(expertAsset) && statSync(expertAsset).isFile()) { sendExpertAsset(request, response, expertAsset); return; }
  const staticPathname = url.pathname === "/favicon.ico" ? "/favicon.svg" : url.pathname;
  const path = assetPath(staticPathname);
  if (path && existsSync(path) && statSync(path).isFile()) { sendAsset(request, response, path); return; }
  response.writeHead(404, { ...securityHeaders, "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" }); response.end("Not found");
}

// Windows resolves localhost to both ::1 and 127.0.0.1.  Edge and local proxy
// clients may prefer IPv6, so keep two loopback-only listeners instead of
// exposing the workbench on 0.0.0.0/::.
const servers = [];
function startListener(listenHost, required = true) {
  const listener = http.createServer(handleRequest);
  listener.on("error", (error) => {
    if (required) throw error;
    console.log(`Aster optional loopback unavailable ${listenHost}:${port} (${error.code || error.message})`);
  });
  listener.listen(port, listenHost, () => {
    const label = listenHost.includes(":") ? `[${listenHost}]` : listenHost;
    console.log(`Aster fast web http://${label}:${port}`);
  });
  servers.push(listener);
}

startListener(host);
if (host === "127.0.0.1") startListener("::1", false);

function shutdown() {
  let pending = servers.length;
  if (!pending) process.exit(0);
  for (const listener of servers) listener.close(() => { pending -= 1; if (!pending) process.exit(0); });
}
process.on("SIGINT", shutdown); process.on("SIGTERM", shutdown);
