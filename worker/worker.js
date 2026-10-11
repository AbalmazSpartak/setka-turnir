// Посредник для страницы: забирает турниры Setka Cup за день и отдаёт их с разрешением для браузера (CORS).
// Setka не разрешает сайтам загружать свои данные напрямую, поэтому страница ходит сюда:
// GET https://<worker>/?date=2026-10-05
const ALLOWED_ORIGINS = ["https://abalmazspartak.github.io", "http://localhost:8000"];

// Обезличенная метка посетителя: отпечаток адреса и браузера с солью дня. Каждые сутки — новая,
// поэтому человека не отследить между днями, а сам адрес нигде не хранится
async function visitorTag(request) {
  const day = new Date().toISOString().slice(0, 10);
  const raw = `${request.headers.get("CF-Connecting-IP") ?? ""}|${request.headers.get("User-Agent") ?? ""}|${day}|setka`;
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
  return [...new Uint8Array(hash)].slice(0, 8).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Статистика посещений (Workers Analytics Engine): страна, метка посетителя, дата турнира, откуда открыт сайт
async function recordVisit(env, request, date) {
  if (!env.VISITS) return;
  env.VISITS.writeDataPoint({
    blobs: [request.cf?.country ?? "??", await visitorTag(request), date, request.headers.get("Origin") ?? ""],
    doubles: [1],
    indexes: ["visit"],
  });
}

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get("Origin") ?? "";
    const cors = {
      "Access-Control-Allow-Origin": ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      Vary: "Origin",
    };
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });

    const date = new URL(request.url).searchParams.get("date") ?? "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return new Response(JSON.stringify({ error: "Нужна дата в формате 2026-10-05" }), {
        status: 400,
        headers: { ...cors, "Content-Type": "application/json; charset=utf-8" },
      });
    }

    ctx.waitUntil(recordVisit(env, request, date));

    const upstream = await fetch(`https://tabletennis.setkacup.com/api/Tournaments/ru?date=${date}`, {
      // Короткий кэш: одновременные запросы одного дня не дёргают Setka, а счёт идущих матчей остаётся свежим
      cf: { cacheTtl: 15, cacheEverything: true },
    });
    return new Response(upstream.body, {
      status: upstream.status,
      headers: { ...cors, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
    });
  },
};
