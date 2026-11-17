// Посредник для страницы: забирает данные Setka Cup и отдаёт их с разрешением для браузера (CORS).
// Setka не разрешает сайтам загружать свои данные напрямую, поэтому страница ходит сюда:
//   ?date=2026-10-05            — все турниры дня (Setka отвечает 8–15 с)
//   ?date=2026-10-05&period=2   — турниры одной части суток: Утро, Вечер, Ночь… (1–5 с)
//   ?date=2026-10-05&location=7 — турниры одного зала за день (Сеул — 7, Токио — 8; около 1 с); можно вместе с period
//   ?t=63928&date=2026-10-05    — только матчи одного турнира, без статуса и итогов Setka (доли секунды)
//   ?periods=1                  — список частей суток
//   ?live=1                     — матчи, которые идут прямо сейчас: по одному на играющий зал (доли секунды)
//   ?ratings=670,1997,…         — рейтинг Setka игроков (до 20): { "670": 57.4, … }, копия на сутки
//   ?history=1997,2949,…&date=2026-11-05 — рейтинг Setka игроков (до 20) накануне дня и в конце дня:
//                               { "1997": { before, after }, … } (Setka отвечает 15–20 с; прошлые дни — копия на месяц)
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
  if (params.has("live")) return { url: `${SETKA}/Matches/widget/ru`, key: "live", date: null, ttl: 0, trim: "matches" };
  if (params.has("ratings")) {
    const ids = [...new Set(params.get("ratings").split(","))].sort();
    return ids.length && ids.length <= MAX_RATINGS && ids.every((id) => /^\d{1,9}$/.test(id))
      ? { ratings: ids, key: `ratings/${ids.join(",")}`, date: null, ttl: 86400 }
      : null;
  }
  if (params.has("history")) {
    const ids = [...new Set(params.get("history").split(","))].sort();
    if (!day || !ids.length || ids.length > MAX_RATINGS || !ids.every((id) => /^\d{1,9}$/.test(id))) return null;
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    return { history: { ids: ids.map(Number), day }, key: `history/${day}/${ids.join(",")}`, date: null, ttl: day < yesterday ? 2592000 : 600 };
  }
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

// --- Рейтинги игроков ---
// Setka отдаёт рейтинг только в карточке игрока (/Players/ru/<id>) — вместе со всей историей его турниров, до 200 КБ.
// Рейтинг стоит в самом начале: читаем первые килобайты и обрываем загрузку — мало трафика и работы для Cloudflare

const MAX_RATINGS = 20;

async function ratingOf(id) {
  try {
    const response = await fetch(`${SETKA}/Players/ru/${id}`);
    if (!response.ok || !response.body) return null;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = "";
    let match = null;
    while (!match && text.length < 8000) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      match = text.match(/"ratingSc":(null|-?[\d.]+)[,}]/);
    }
    reader.cancel().catch(() => {});
    const rating = match && match[1] !== "null" ? Number(match[1]) : null;
    return Number.isFinite(rating) ? rating : null;
  } catch {
    return null;
  }
}

/** Рейтинги Setka игроков: { id: число или null } */
export async function ratingsFor(ids) {
  const values = await Promise.all(ids.map(ratingOf));
  return Object.fromEntries(ids.map((id, i) => [id, values[i]]));
}

// --- Рейтинг игроков на дату: страница Setka «Рейтинг на дату» — все 3000 игроков одним ответом (840 КБ, 15–20 с).
// Ответ целиком запоминается (прошлые дни — на месяц), нужные игроки ищутся в тексте без разбора JSON:
// разбор 840 КБ не уложился бы в лимит Cloudflare 10 мс

const dayBefore = (iso) => new Date(Date.parse(`${iso}T12:00:00Z`) - 86400000).toISOString().slice(0, 10);

async function snapshotText(date, ctx) {
  const key = new Request(`https://setka-turnir.cache/v4/snapshot/${date}`);
  const cache = globalThis.caches?.default; // нет у локального посредника tools/dev-server.mjs
  const cached = await cache?.match(key);
  if (cached) return cached.text();
  const response = await fetch(`${SETKA}/Players/ru/rating?date=${date}&page=1`);
  if (!response.ok) return null;
  const text = await response.text();
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const ttl = date < yesterday ? 2592000 : 600;
  if (cache && text.includes('"ratingSc"')) ctx?.waitUntil(cache.put(key, new Response(text, { headers: { "Cache-Control": `max-age=${ttl}` } })));
  return text;
}

/** Рейтинг игрока в тексте ответа Setka: {"id":1997,…,"ratingSc":"37.9",…} */
function ratingInText(text, id) {
  if (!text) return null;
  const at = text.indexOf(`{"id":${id},`);
  if (at < 0) return null;
  const end = text.indexOf("}", at);
  const match = text.slice(at, end).match(/"ratingSc":"?(-?[\d.]+)/);
  const value = match ? Number(match[1]) : NaN;
  return Number.isFinite(value) && value > 0 ? value : null;
}

/** Рейтинг Setka игроков накануне дня (до его турниров) и на этот день (после): { id: { before, after } } */
export async function historyFor({ ids, day }, ctx) {
  const [before, after] = await Promise.all([snapshotText(dayBefore(day), ctx), snapshotText(day, ctx)]);
  return Object.fromEntries(ids.map((id) => [id, { before: ratingInText(before, id), after: ratingInText(after, id) }]));
}

// --- Только поля, которые читает страница (standings.js, parseTournament) ---
// Setka присылает втрое больше: фото и цвета игроков, все матчи ещё раз в итогах турнира.
// Понадобилось сайту новое поле Setka — добавить его и здесь

// Поля перечислены прямо, без общего «выбрать ключи»: так меньше работы, а лимит Cloudflare — 10 мс на запрос.
// Отсутствующие поля (undefined) JSON.stringify пропускает сам
const isObject = (o) => o && typeof o === "object" && !Array.isArray(o);
const trimPlayer = (p) => (isObject(p) ? { id: p.id, firstName: p.firstName, lastName: p.lastName } : p);

/**
 * Время начала матча (startDate) — у всех: страница показывает его в списке матчей.
 * meta — у матчей без турнира вокруг (?t=, ?live=) ещё турнир, его название, зал и время дня:
 * по ним страница узнаёт часть суток турнира и его день у Setka (ночные турниры Setka относит к предыдущему дню)
 */
function trimMatch(m, meta) {
  if (!m || typeof m !== "object") return m;
  const out = {
    id: m.id, position: m.position, forPositionId: m.forPositionId,
    player1Score: m.player1Score, player2Score: m.player2Score, technicalResult: m.technicalResult, statusId: m.statusId,
    startDate: m.startDate,
    player1: trimPlayer(m.player1), player2: trimPlayer(m.player2),
    winner: isObject(m.winner) ? { id: m.winner.id } : m.winner,
    setScores: Array.isArray(m.setScores) ? m.setScores.map((s) => (isObject(s) ? { p1Score: s.p1Score, p2Score: s.p2Score } : s)) : m.setScores,
  };
  if (meta) {
    Object.assign(out, {
      tournamentId: m.tournamentId, tournamentName: m.tournamentName, locationId: m.locationId, dayPeriodToken: m.dayPeriodToken,
    });
  }
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
    id: t.id, token: t.token, locationId: t.locationId, dayPeriodToken: t.dayPeriodToken, statusCode: t.statusCode, startDate: t.startDate,
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

    if (!params.has("more") && !params.has("periods") && !params.has("live") && !params.has("ratings") && !params.has("history")) ctx.waitUntil(recordVisit(env, request, target.date ?? ""));

    // Сегодня и вчера (ночные турниры доигрывают после полуночи) — без копии, чтобы счёт идущих матчей был свежим;
    // дни раньше уже закрыты — временная копия на час в кэше Cloudflare (Setka отвечает 10 с и дольше)
    // и в браузере посетителя: тот же день, открытый снова, не скачивается заново.
    // Setka сама за Cloudflare, поэтому cf.cacheTtl на её запросе не действует — нужен свой кэш
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const ttl = target.ttl ?? (target.date && target.date < yesterday ? 3600 : 0);
    const key = new Request(`https://setka-turnir.cache/v4/${target.key}`);
    let body = ttl ? await caches.default.match(key) : undefined;
    const hit = Boolean(body);
    if (!body && (target.ratings || target.history)) {
      const json = target.ratings ? await ratingsFor(target.ratings) : await historyFor(target.history, ctx);
      body = new Response(JSON.stringify(json), { headers: { ...JSON_HEADERS, "Cache-Control": `max-age=${ttl}` } });
      // Setka не ответила (у всех пусто) — не запоминаем
      const empty = target.history && Object.values(json).every((r) => r.before == null && r.after == null);
      if (!empty) ctx.waitUntil(caches.default.put(key, body.clone()));
    }
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
