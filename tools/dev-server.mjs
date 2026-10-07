// Локальный просмотр страницы: node tools/dev-server.mjs → http://localhost:8000
// Отдаёт файлы и, как посредник на Cloudflare, пересылает /api?date=… в Setka
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".json": "application/json" };

createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/api") {
    const date = url.searchParams.get("date") ?? "";
    const upstream = await fetch(`https://tabletennis.setkacup.com/api/Tournaments/ru?date=${encodeURIComponent(date)}`);
    res.writeHead(upstream.status, { "Content-Type": "application/json; charset=utf-8" });
    res.end(Buffer.from(await upstream.arrayBuffer()));
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
