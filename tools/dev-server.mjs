// Локальный просмотр страницы: node tools/dev-server.mjs → http://localhost:8000
// Отдаёт файлы и, как посредник на Cloudflare, пересылает /api?date=… (и другие его запросы) в Setka
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { upstreamFor, trimText } from "../worker/worker.js";

const root = new URL("..", import.meta.url).pathname;
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".webp": "image/webp", ".json": "application/json", ".webmanifest": "application/manifest+json" };

createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/api") {
    const target = upstreamFor(url.searchParams);
    if (!target) return res.writeHead(400).end();
    const upstream = await fetch(target.url);
    const text = await upstream.text();
    res.writeHead(upstream.status, { "Content-Type": "application/json; charset=utf-8" });
    res.end(upstream.ok && target.trim ? trimText(target.trim, text) : text);
    return;
  }
  const path = normalize(join(root, url.pathname === "/" ? "index.html" : url.pathname));
  if (!path.startsWith(root)) return res.writeHead(403).end();
  try {
    const body = await readFile(path);
    res.writeHead(200, { "Content-Type": types[extname(path)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end("Not found");
  }
}).listen(8000, () => console.log("http://localhost:8000"));
