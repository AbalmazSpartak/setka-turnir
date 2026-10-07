// Места в турнире Setka Cup по правилам ITTF для круговой системы.
// Очки: победа 2, поражение 1, техническое поражение 0. При равенстве очков сравниваются
// только встречи между равными: очки, затем соотношение партий, затем мячей. Кто отделился —
// выбывает, остальные сравниваются заново между собой. Полное равенство — жребий.
// Тот же подсчёт, что в приложениях для iPhone и Android; сверен с официальными местами Setka

/** Число из поля, которое Setka присылает то числом, то строкой */
const int = (value, fallback = 0) => {
  const n = Number.parseInt(value, 10);
  return Number.isNaN(n) ? fallback : n;
};

const player = (p) => (p && p.id != null ? { id: p.id, firstName: p.firstName ?? "", lastName: p.lastName ?? "" } : null);

export const fullName = (p) => `${p.lastName} ${p.firstName}`.trim();

/** Ответ Setka → турниры; турнир с неожиданными данными пропускается, а не ломает весь день */
export function parseTournaments(json) {
  return (Array.isArray(json) ? json : []).flatMap((t) => {
    try {
      return [parseTournament(t)];
    } catch {
      return [];
    }
  });
}

function parseTournament(t) {
  const matches = (t.matches ?? []).map((m) => {
    const setScores = (m.setScores ?? []).map((s) => ({ p1: int(s.p1Score), p2: int(s.p2Score) }));
    return {
      id: m.id,
      position: int(m.position),
      forPositionId: int(m.forPositionId, 1),
      player1: player(m.player1),
      player2: player(m.player2),
      score1: m.player1Score == null ? null : String(m.player1Score),
      score2: m.player2Score == null ? null : String(m.player2Score),
      technical: int(m.technicalResult) !== 0,
      winnerId: m.winner?.id ?? null,
      statusId: m.statusId == null ? null : int(m.statusId),
      setScores,
    };
  });
  return {
    id: t.id,
    token: t.token ?? "",
    locationId: int(t.locationId),
    dayPeriodToken: int(t.dayPeriodToken),
    statusCode: t.statusCode ?? "",
    matches,
    officialPlaces: officialPlaces(t.result),
  };
}

/** Места у Setka — нужны только для порядка при жребии. У незавершённых турниров поля бывают пустыми массивами */
function officialPlaces(result) {
  const places = new Map();
  if (!result || typeof result !== "object" || Array.isArray(result)) return places;
  const positions = result.positions && !Array.isArray(result.positions) ? result.positions : {};
  const players = result.players && !Array.isArray(result.players) ? result.players : {};
  for (const [key, p] of Object.entries(players)) {
    const value = positions[key] ?? p?.real_position ?? p?.position;
    if (value) places.set(int(key), int(value));
  }
  return places;
}

// --- Турнир и матчи ---

export const tournamentTitle = (t) => {
  const [first, rest] = [t.token.slice(0, 10), t.token.slice(11)];
  return /^\d{4}-\d{2}-\d{2}$/.test(first) && rest ? rest : t.token;
};

export const isFinished = (t) => t.statusCode === "finished";

/** Матч идёт прямо сейчас: начат, но победителя ещё нет */
export const isLive = (m) => m.winnerId == null && (m.statusId === 2 || m.setScores.length > 0);

export const isNotStarted = (t) => t.statusCode === "public" || t.matches.every((m) => m.winnerId == null && !isLive(m));

const setFinished = (s) => Math.max(s.p1, s.p2) >= 11 && Math.abs(s.p1 - s.p2) >= 2;

/** Счёт идущего матча: «0:2 по партиям, 3-я партия 10:8» */
export function liveScore(m) {
  const done = m.setScores.filter(setFinished);
  const won1 = done.filter((s) => s.p1 > s.p2).length;
  let text = `${won1}:${done.length - won1} по партиям`;
  const current = m.setScores.at(-1);
  if (current && !setFinished(current)) text += `, ${m.setScores.length}-я партия ${current.p1}:${current.p2}`;
  return text;
}

/** Сыгранная встреча в удобном для подсчёта виде; null — ещё не сыграна */
export function game(m) {
  if (!m.player1 || !m.player2 || m.winnerId == null) return null;
  const sets = (own) => (own === "W" ? 3 : own === "L" ? 0 : int(own));
  let s1 = sets(m.score1);
  let s2 = sets(m.score2);
  // Счёт не заполнен, а победитель есть — засчитываем по победителю
  if (s1 === s2) {
    s1 = m.winnerId === m.player1.id ? 3 : 0;
    s2 = m.winnerId === m.player2.id ? 3 : 0;
  }
  const g = {
    p1: m.player1.id,
    p2: m.player2.id,
    s1,
    s2,
    b1: m.setScores.reduce((a, s) => a + s.p1, 0),
    b2: m.setScores.reduce((a, s) => a + s.p2, 0),
    walkover: m.technical,
  };
  g.winner = s1 > s2 ? g.p1 : g.p2;
  g.loser = s1 > s2 ? g.p2 : g.p1;
  return g;
}

// --- Подсчёт ---

const emptyRecord = () => ({ points: 0, wins: 0, losses: 0, setsWon: 0, setsLost: 0, ballsWon: 0, ballsLost: 0 });

function records(ids, games) {
  const result = new Map([...ids].map((id) => [id, emptyRecord()]));
  for (const g of games) {
    if (!ids.has(g.p1) || !ids.has(g.p2)) continue;
    const loserPoints = g.walkover ? 0 : 1;
    const first = g.winner === g.p1;
    const r1 = result.get(g.p1);
    const r2 = result.get(g.p2);
    r1.points += first ? 2 : loserPoints;
    r2.points += first ? loserPoints : 2;
    result.get(g.winner).wins += 1;
    result.get(g.loser).losses += 1;
    r1.setsWon += g.s1; r1.setsLost += g.s2;
    r2.setsWon += g.s2; r2.setsLost += g.s1;
    r1.ballsWon += g.b1; r1.ballsLost += g.b2;
    r2.ballsWon += g.b2; r2.ballsLost += g.b1;
  }
  return result;
}

/** Соотношение «выиграно : проиграно» без деления; x:0 больше любого конечного */
const compareRatio = (a, b) => a[0] * b[1] - b[0] * a[1];

/** Делит игроков на группы с равным показателем, от большего к меньшему */
function split(ids, key) {
  const buckets = [];
  for (const id of [...ids].sort((a, b) => compareRatio(key(b), key(a)))) {
    const last = buckets.at(-1);
    if (last && compareRatio(key(last[0]), key(id)) === 0) last.push(id);
    else buckets.push([id]);
  }
  return buckets;
}

export function pointsNoun(n) {
  const mod10 = n % 10, mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return "очку";
  if (mod10 >= 2 && mod10 <= 4 && !(mod100 >= 12 && mod100 <= 14)) return "очка";
  return "очков";
}

export function playersNoun(n) {
  const mod10 = n % 10, mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return "игрок";
  if (mod10 >= 2 && mod10 <= 4 && !(mod100 >= 12 && mod100 <= 14)) return "игрока";
  return "игроков";
}

class Ranker {
  constructor(games, players, lotOrder) {
    this.games = games;
    this.players = players;
    this.lotOrder = lotOrder;
    this.ties = [];
  }

  name(id) {
    return this.players.get(id)?.lastName ?? `#${id}`;
  }

  list(ids) {
    const names = ids.map((id) => this.name(id));
    return names.length < 2 ? names[0] ?? "" : `${names.slice(0, -1).join(", ")} и ${names.at(-1)}`;
  }

  /** Порядок мест: группы по одному игроку, группа из нескольких — равенство, решает жребий */
  rank(ids) {
    const totals = records(new Set(ids), this.games);
    const order = [];
    for (const bucket of split(ids, (id) => [totals.get(id).points, 1])) {
      if (bucket.length === 1) {
        order.push(bucket);
        continue;
      }
      const lines = [];
      const points = totals.get(bucket[0]).points;
      const title = `${bucket.map((id) => this.name(id)).join(", ")} — по ${points} ${pointsNoun(points)}`;
      order.push(...this.breakTie(bucket, lines, 0));
      this.ties.push({ title, lines });
    }
    return order;
  }

  /** Сравнение только по встречам между равными; отделившиеся выбывают, остальные — заново */
  breakTie(ids, lines, depth) {
    const subset = new Set(ids);
    const rec = records(subset, this.games);
    const prefix = depth === 0 ? "" : `Между ${this.list(ids)}: `;

    // Двое и одна встреча между ними — решает она. В двухкруговых турнирах встреч две, тогда — по общим правилам
    const between = this.games.filter((g) => subset.has(g.p1) && subset.has(g.p2));
    if (ids.length === 2 && between.length === 1) {
      const g = between[0];
      const score = g.winner === g.p1 ? `${g.s1}:${g.s2}` : `${g.s2}:${g.s1}`;
      lines.push(`${prefix}личная встреча — ${this.name(g.winner)} выиграл ${score}${g.walkover ? " (тех.)" : ""}`);
      return [[g.winner], [g.loser]];
    }

    const criteria = [
      { name: "очки во встречах между собой", short: "очки", key: (id) => [rec.get(id).points, 1], label: (id) => `${rec.get(id).points}` },
      { name: "партии между собой", short: "партии", key: (id) => [rec.get(id).setsWon, rec.get(id).setsLost], label: (id) => `${rec.get(id).setsWon}:${rec.get(id).setsLost}` },
      { name: "мячи между собой", short: "мячи", key: (id) => [rec.get(id).ballsWon, rec.get(id).ballsLost], label: (id) => `${rec.get(id).ballsWon}:${rec.get(id).ballsLost}` },
    ];
    // Равные показатели собираются в одну фразу: «очки по 3, партии по 5:5»
    const equal = [];
    for (const c of criteria) {
      const buckets = split(ids, c.key);
      const labels = ids.map(c.label);
      if (buckets.length === 1) {
        equal.push(new Set(labels).size === 1
          ? `${c.short} по ${labels[0]}`
          : `${c.short} поровну (${ids.map((id) => `${this.name(id)} ${c.label(id)}`).join(" · ")})`);
        continue;
      }
      const values = buckets.flat().map((id) => `${this.name(id)} ${c.label(id)}`).join(" · ");
      const lead = equal.length ? `${equal.join(", ")}, поэтому ` : "";
      lines.push(`${prefix}${lead}${c.name}: ${values}`);
      const order = [];
      for (const bucket of buckets) {
        if (bucket.length === 1) order.push(bucket);
        else order.push(...this.breakTie(bucket, lines, depth + 1));
      }
      return order;
    }
    lines.push(`${prefix}всё поровну — ${equal.join(", ")}. Места решает жребий`);
    const lot = (id) => this.lotOrder.get(id) ?? Number.MAX_SAFE_INTEGER;
    return [[...ids].sort((a, b) => lot(a) - lot(b))];
  }
}

/**
 * Таблица турнира: rows — игроки с местом в группе (groupPlace) и итоговым (place),
 * ties — объяснения равенств, groupMatches / placementMatches, playedCount
 */
export function standings(t) {
  const groupMatches = t.matches.filter((m) => m.forPositionId <= 1).sort((a, b) => a.position - b.position);
  const placementMatches = t.matches.filter((m) => m.forPositionId > 1).sort((a, b) => a.forPositionId - b.forPositionId);

  const players = new Map();
  for (const m of t.matches) for (const p of [m.player1, m.player2]) if (p) players.set(p.id, p);
  const games = groupMatches.map(game).filter(Boolean);

  const ranker = new Ranker(games, players, t.officialPlaces);
  const order = ranker.rank([...players.keys()].sort((a, b) => a - b));
  const totals = records(new Set(players.keys()), games);

  const groupPlace = new Map();
  const lot = new Set();
  for (const bucket of order) {
    for (const id of bucket) {
      groupPlace.set(id, groupPlace.size + 1);
      if (bucket.length > 1) lot.add(id);
    }
  }

  // Финал (forPositionId 2) решает 1–2 места, матч за 3-е (3) — 3–4
  const finalPlace = new Map(groupPlace);
  for (const m of placementMatches) {
    const g = game(m);
    if (!g) continue;
    const base = m.forPositionId === 2 ? 1 : m.forPositionId;
    finalPlace.set(g.winner, base);
    finalPlace.set(g.loser, base + 1);
  }

  const rows = [...players.values()].map((p) => ({
    player: p,
    groupPlace: groupPlace.get(p.id) ?? 0,
    place: finalPlace.get(p.id) ?? 0,
    record: totals.get(p.id) ?? emptyRecord(),
    byLot: lot.has(p.id),
  }));

  return {
    rows,
    ties: ranker.ties,
    groupMatches,
    placementMatches,
    playedCount: games.length,
    get isGroupComplete() { return this.playedCount === groupMatches.length; },
    get hasPlacementMatches() { return placementMatches.length > 0; },
    get placementDone() { return placementMatches.every((m) => m.winnerId != null); },
  };
}

// --- Ссылка ---

/** setkacup.com/ru/schedule?date=2026-10-05&hall=7&period=3 (в том числе внутри текста) → { date, hall, period } */
export function parseLink(text) {
  const raw = String(text).trim().split(/\s+/).find((part) => part.includes("setkacup"));
  if (!raw) return null;
  let url;
  try {
    url = new URL(raw.includes("://") ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  const date = url.searchParams.get("date");
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const optional = (name) => {
    const n = Number.parseInt(url.searchParams.get(name) ?? "", 10);
    return Number.isNaN(n) ? null : n;
  };
  return { date, hall: optional("hall"), period: optional("period") };
}

export const matchesLink = (t, link) =>
  (link.hall == null || t.locationId === link.hall) && (link.period == null || t.dayPeriodToken === link.period);
