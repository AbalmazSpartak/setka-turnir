// Посредник для страницы: забирает данные Setka Cup и отдаёт их с разрешением для браузера (CORS).
// Setka не разрешает сайтам загружать свои данные напрямую, поэтому страница ходит сюда:
//   ?date=2026-10-05            — все турниры дня (Setka отвечает 8–15 с)
//   ?date=2026-10-05&period=2   — турниры одной части суток: Утро, Вечер, Ночь… (1–5 с)
//   ?date=2026-10-05&location=7 — турниры одного зала за день (Сеул — 7, Токио — 8; около 1 с); можно вместе с period
//   ?t=63928&date=2026-10-05    — только матчи одного турнира, без статуса и итогов Setka (доли секунды)
//   ?periods=1                  — список частей суток
// &more=1 — дополнительный запрос той же загрузки страницы: в статистику посещений не пишется
const SETKA = "https://tabletennis.setkacup.com/api";
const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };
const ALLOWED_ORIGINS = ["https://abalmazspartak.github.io", "http://localhost:8000"];

/**
 * Что запросить у Setka: адрес, ключ для кэша, день данных (для кэша и статистики), срок копии для любого дня,
 * что урезать (trim). null — запрос неверный. Тот же разбор использует локальный посредник tools/dev-server.mjs
 */
export function upstreamFor(params) {
  const date = params.get("date") ?? "";
  const day = /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null;
  if (params.has("periods")) return { url: `${SETKA}/DayPeriods/ru`, key: "periods", date: null, ttl: 86400 };
  if (params.has("t")) {
    const id = params.get("t");
    return /^\d{1,9}$/.test(id)
      ? { url: `${SETKA}/Matches/ru?tournamentId=${id}`, key: `t/${id}`, date: day, trim: "matches" }
      : null;
  }
  if (!day) return null;
  const period = params.get("period");
  const location = params.get("location");
  if ((period != null && !/^\d{1,2}$/.test(period)) || (location != null && !/^\d{1,4}$/.test(location))) return null;
  // День целиком (страница зарплаты, запасной путь) — как есть: урезать 500 КБ дольше, чем укладывается в лимит Cloudflare
  if (period == null && location == null) return { url: `${SETKA}/Tournaments/ru?date=${day}`, key: `day/${day}`, date: day };
  // Часть суток (dayPeriod) и/или один зал (location) — Setka отдаёт их в разы быстрее всего дня
  const filter = `${period != null ? `&dayPeriod=${period}` : ""}${location != null ? `&location=${location}` : ""}`;
  return {
    url: `${SETKA}/Tournaments/ru?date=${day}${filter}`, key: `day/${day}/${period ?? "*"}/${location ?? "*"}`, date: day, trim: "tournaments",
  };
}

// --- Только поля, которые читает страница (standings.js, parseTournament) ---
// Setka присылает втрое больше: фото и цвета игроков, все матчи ещё раз в итогах турнира.
// Понадобилось сайту новое поле Setka — добавить его и здесь

// Поля перечислены прямо, без общего «выбрать ключи»: так меньше работы, а лимит Cloudflare — 10 мс на запрос.
// Отсутствующие поля (undefined) JSON.stringify пропускает сам
const isObject = (o) => o && typeof o === "object" && !Array.isArray(o);
const trimPlayer = (p) => (isObject(p) ? { id: p.id, firstName: p.firstName, lastName: p.lastName } : p);

/** meta — у матчей одного турнира (?t=) ещё название, зал и время дня: по ним страница узнаёт его часть суток */
function trimMatch(m, meta) {
  if (!m || typeof m !== "object") return m;
  const out = {
    id: m.id, position: m.position, forPositionId: m.forPositionId,
    player1Score: m.player1Score, player2Score: m.player2Score, technicalResult: m.technicalResult, statusId: m.statusId,
    player1: trimPlayer(m.player1), player2: trimPlayer(m.player2),
    winner: isObject(m.winner) ? { id: m.winner.id } : m.winner,
    setScores: Array.isArray(m.setScores) ? m.setScores.map((s) => (isObject(s) ? { p1Score: s.p1Score, p2Score: s.p2Score } : s)) : m.setScores,
  };
  if (meta) Object.assign(out, { tournamentName: m.tournamentName, locationId: m.locationId, dayPeriodToken: m.dayPeriodToken });
  return out;
}

/** Итоги Setka: только места (для жребия и сверки) — без матчей, очков, имён и фото */
function trimResult(r) {
  if (!isObject(r)) return r;
  let players = r.players;
  if (isObject(players)) {
    players = {};
    for (const key in r.players) {
      const p = r.players[key];
      players[key] = isObject(p) ? { position: p.position, real_position: p.real_position } : p;
    }
  }
  return { positions: r.positions, players };
}

function trimTournament(t) {
  if (!t || typeof t !== "object") return t;
  return {
    id: t.id, token: t.token, locationId: t.locationId, dayPeriodToken: t.dayPeriodToken, statusCode: t.statusCode,
    result: trimResult(t.result),
    matches: Array.isArray(t.matches) ? t.matches.map((m) => trimMatch(m, false)) : t.matches,
  };
}

/** Ответ Setka → только нужное странице; не JSON или неожиданный вид — как есть, разберётся страница */
export function trimText(trim, text) {
  try {
    const json = JSON.parse(text);
    if (!Array.isArray(json)) return text;
    return JSON.stringify(trim === "matches" ? json.map((m) => trimMatch(m, true)) : json.map(trimTournament));
  } catch {
    return text;
  }
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
    // дни раньше уже закрыты — временная копия на час в кэше Cloudflare (Setka отвечает 10 с и дольше)
    // и в браузере посетителя: тот же день, открытый снова, не скачивается заново.
    // Setka сама за Cloudflare, поэтому cf.cacheTtl на её запросе не действует — нужен свой кэш
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const ttl = target.ttl ?? (target.date && target.date < yesterday ? 3600 : 0);
    const key = new Request(`https://setka-turnir.cache/v2/${target.key}`);
    let body = ttl ? await caches.default.match(key) : undefined;
    const hit = Boolean(body);
    if (!body) {
      const upstream = await fetch(target.url);
      if (!upstream.ok) {
        return new Response(upstream.body, { status: upstream.status, headers: { ...cors, ...JSON_HEADERS } });
      }
      const payload = target.trim ? trimText(target.trim, await upstream.text()) : upstream.body;
      if (!ttl) return new Response(payload, { headers: { ...cors, ...JSON_HEADERS } });
      body = new Response(payload, { headers: { ...JSON_HEADERS, "Cache-Control": `max-age=${ttl}` } });
      ctx.waitUntil(caches.default.put(key, body.clone()));
    }
    return new Response(body.body, {
      headers: { ...cors, ...JSON_HEADERS, "Cache-Control": `private, max-age=${ttl}`, "X-Cache": hit ? "HIT" : "MISS" },
    });
  },
};
