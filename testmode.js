// Раздел «🧪 Тест»: свой турнир из введённых данных — для проверки логики подсчёта.
// Турнир собирается в том же виде, что и турниры Setka после разбора, и считается тем же standings.js.
// Данные хранятся прямо в ссылке (?test=view&d=…), поэтому тест можно отправить или открыть позже

/** Исходы матча в списке: значение → подпись (A и B — первый и второй игрок пары) */
export const RESULTS = [
  ["", "не сыгран"],
  ["3:0", "3:0"], ["3:1", "3:1"], ["3:2", "3:2"],
  ["2:3", "2:3"], ["1:3", "1:3"], ["0:3", "0:3"],
  ["W1", "тех. победа A"], ["W2", "тех. победа B"],
  ["LL", "L : L — поражение обоим"],
];

export const MIN_PLAYERS = 3;
export const MAX_PLAYERS = 8;

/** Пары круговой системы в порядке туров (метод «по кругу»), чтобы матчи шли как в настоящем турнире */
export function pairs(n) {
  const ids = [...Array(n).keys()];
  if (n % 2) ids.push(null);
  const rounds = [];
  const size = ids.length;
  let order = ids;
  for (let r = 0; r < size - 1; r++) {
    for (let k = 0; k < size / 2; k++) {
      const a = order[k], b = order[size - 1 - k];
      if (a != null && b != null) rounds.push(a < b ? [a, b] : [b, a]);
    }
    order = [order[0], order.at(-1), ...order.slice(1, -1)];
  }
  return rounds;
}

/** Пустой тест на 4 игрока */
export const emptyTest = () => ({ players: ["Игрок 1", "Игрок 2", "Игрок 3", "Игрок 4"], results: {}, closed: true });

/** Ключ пары: номера игроков «0-2» */
export const pairKey = (a, b) => `${a}-${b}`;

/** «11:7 9:11 11:5» → [{p1, p2}…]; пустая строка — партий нет */
export function parseSets(text) {
  return String(text ?? "").trim().split(/[\s,;]+/).filter(Boolean).flatMap((part) => {
    const match = part.match(/^(\d{1,2})[:\-](\d{1,2})$/);
    return match ? [{ p1: Number(match[1]), p2: Number(match[2]) }] : [];
  });
}

/** Партии не сходятся с выбранным счётом — подсказка в редакторе */
export function setsMismatch(result, setsText) {
  const sets = parseSets(setsText);
  if (!sets.length || !/^\d:\d$/.test(result)) return false;
  const [a, b] = result.split(":").map(Number);
  const won = sets.filter((s) => s.p1 > s.p2).length;
  return won !== a || sets.length - won !== b;
}

/** Данные теста → турнир в формате parseTournaments */
export function buildTournament(data) {
  const players = data.players.map((name, i) => ({ id: i + 1, firstName: "", lastName: name.trim() || `Игрок ${i + 1}` }));
  const matches = pairs(players.length).map(([a, b], index) => {
    const { r = "", sets = "" } = data.results[pairKey(a, b)] ?? {};
    const p1 = players[a], p2 = players[b];
    const base = {
      id: index + 1, position: index + 1, forPositionId: 1, player1: p1, player2: p2,
      score1: "0", score2: "0", technical: false, winnerId: null, statusId: 1, setScores: [],
    };
    if (/^\d:\d$/.test(r)) {
      const [s1, s2] = r.split(":");
      return { ...base, score1: s1, score2: s2, winnerId: Number(s1) > Number(s2) ? p1.id : p2.id, statusId: 3, setScores: parseSets(sets) };
    }
    if (r === "W1" || r === "W2") {
      const first = r === "W1";
      return {
        ...base, score1: first ? "W" : "L", score2: first ? "L" : "W", technical: true, winnerId: first ? p1.id : p2.id, statusId: 4,
        setScores: Array.from({ length: 3 }, () => (first ? { p1: 11, p2: 0 } : { p1: 0, p2: 11 })),
      };
    }
    if (r === "LL") return { ...base, score1: "L", score2: "L", technical: true, statusId: 4 };
    return base;
  });
  return {
    id: -1,
    token: "Свой турнир (тест)",
    locationId: 0,
    dayPeriodToken: 0,
    statusCode: data.closed ? "finished" : "started",
    matches,
    officialPlaces: new Map(),
    setka: { hasFinal: false, places: new Map() },
    isTest: true,
  };
}

/** Случайные результаты всех матчей: обычный счёт с партиями, изредка неявка */
export function randomResults(n) {
  const results = {};
  const rnd = (k) => Math.floor(Math.random() * k);
  for (const [a, b] of pairs(n)) {
    if (Math.random() < 0.06) {
      results[pairKey(a, b)] = { r: Math.random() < 0.5 ? "W1" : "W2", sets: "" };
      continue;
    }
    const firstWins = Math.random() < 0.5;
    const lost = rnd(3);
    const order = [...Array(3).fill(true), ...Array(lost).fill(false)].sort(() => Math.random() - 0.5);
    // Решающая партия — за победителем
    if (!order.at(-1)) order.push(order.splice(order.lastIndexOf(true), 1)[0]);
    const sets = order.map((winnerSet) => {
      const loser = Math.random() < 0.2 ? 10 + rnd(4) : rnd(10);
      const w = loser >= 10 ? loser + 2 : 11;
      return winnerSet === firstWins ? `${w}:${loser}` : `${loser}:${w}`;
    });
    results[pairKey(a, b)] = { r: firstWins ? `3:${lost}` : `${lost}:3`, sets: sets.join(" ") };
  }
  return results;
}

// --- Данные в ссылке: JSON → base64url ---

export function encode(data) {
  const bytes = new TextEncoder().encode(JSON.stringify(data));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function decode(text) {
  try {
    const binary = atob(String(text).replace(/-/g, "+").replace(/_/g, "/"));
    const data = JSON.parse(new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0))));
    if (!Array.isArray(data.players) || data.players.length < MIN_PLAYERS) return null;
    return { players: data.players.slice(0, MAX_PLAYERS).map(String), results: data.results ?? {}, closed: data.closed !== false };
  } catch {
    return null;
  }
}
