// Посредник для страницы: забирает данные Setka Cup и отдаёт их с разрешением для браузера (CORS).
// Setka не разрешает сайтам загружать свои данные напрямую, поэтому страница ходит сюда:
//   ?date=2026-10-05            — все турниры дня (Setka отвечает 8–15 с)
//   ?date=2026-10-05&period=2   — турниры одной части суток: Утро, Вечер, Ночь… (1–5 с)
//   ?t=63928&date=2026-10-05    — только матчи одного турнира, без статуса и итогов Setka (доли секунды)
//   ?periods=1                  — список частей суток
// &more=1 — дополнительный запрос той же загрузки страницы: в статистику посещений не пишется
const SETKA = "https://tabletennis.setkacup.com/api";
const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };
const ALLOWED_ORIGINS = ["https://abalmazspartak.github.io", "http://localhost:8000"];

/**
 * Что запросить у Setka: адрес, ключ для кэша, день данных (для кэша и статистики), срок копии для любого дня.
 * null — запрос неверный. Тот же разбор использует локальный посредник tools/dev-server.mjs
 */
export function upstreamFor(params) {
  const date = params.get("date") ?? "";
  const day = /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null;
  if (params.has("periods")) return { url: `${SETKA}/DayPeriods/ru`, key: "periods", date: null, ttl: 86400 };
  if (params.has("t")) {
    const id = params.get("t");
    return /^\d{1,9}$/.test(id) ? { url: `${SETKA}/Matches/ru?tournamentId=${id}`, key: `t/${id}`, date: day } : null;
  }
  if (!day) return null;
  if (params.has("period")) {
    const period = params.get("period");
    return /^\d{1,2}$/.test(period)
      ? { url: `${SETKA}/Tournaments/ru?date=${day}&dayPeriod=${period}`, key: `day/${day}/${period}`, date: day }
      : null;
  }
  return { url: `${SETKA}/Tournaments/ru?date=${day}`, key: `day/${day}`, date: day };
}

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

    const params = new URL(request.url).searchParams;
    const target = upstreamFor(params);
    if (!target) {
      return new Response(JSON.stringify({ error: "Нужна дата в формате 2026-10-05" }), {
        status: 400,
        headers: { ...cors, "Content-Type": "application/json; charset=utf-8" },
      });
    }

    if (!params.has("more") && !params.has("periods")) ctx.waitUntil(recordVisit(env, request, target.date ?? ""));

    // Сегодня и вчера (ночные турниры доигрывают после полуночи) — без копии, чтобы счёт идущих матчей был свежим;
    // дни раньше уже закрыты — временная копия на час в кэше Cloudflare, Setka отвечает 10 с и дольше.
    // Setka сама за Cloudflare, поэтому cf.cacheTtl на её запросе не действует — нужен свой кэш
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const ttl = target.ttl ?? (target.date && target.date < yesterday ? 3600 : 0);
    const key = new Request(`https://setka-turnir.cache/${target.key}`);
    let body = ttl ? await caches.default.match(key) : undefined;
    const hit = Boolean(body);
    if (!body) {
      const upstream = await fetch(target.url);
      if (!upstream.ok || !ttl) {
        return new Response(upstream.body, { status: upstream.status, headers: { ...cors, ...JSON_HEADERS } });
      }
      body = new Response(upstream.body, { headers: { ...JSON_HEADERS, "Cache-Control": `max-age=${ttl}` } });
      ctx.waitUntil(caches.default.put(key, body.clone()));
    }
    return new Response(body.body, { headers: { ...cors, ...JSON_HEADERS, "X-Cache": hit ? "HIT" : "MISS" } });
  },
};
