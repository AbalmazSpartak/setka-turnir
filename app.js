import { API_URL } from "./config.js?v=36";
import {
  parseTournaments, standings, parseLink, matchesLink, tournamentTitle, isFinished, isNotStarted,
  isLive, liveScore, game, fullName, playersNoun, setkaDifference, isDoubleLoss,
} from "./standings.js?v=36";
import { SITUATIONS, detectSituations, setkaLink, trainLevel } from "./situations.js?v=36";
import { toCSV } from "./precedents-csv.js?v=36";
import {
  RESULTS, MIN_PLAYERS, MAX_PLAYERS, pairs, pairKey, emptyTest, buildTournament, randomResults, setsMismatch, encode, decode,
} from "./testmode.js?v=36";
import { PAY, payroll, periodFor, lastPayoutPeriod, daysBetween, addDays, lastPayout } from "./pay.js?v=36";

const app = document.getElementById("app");

// Установка как приложение (Chrome «Установить», iPhone «На экран Домой») — нужен service worker
if ("serviceWorker" in navigator && location.hostname !== "localhost") navigator.serviceWorker.register("sw.js").catch(() => {});

// --- Данные ---

const cache = new Map();

async function loadDay(date, { fresh = false } = {}) {
  if (!fresh && cache.has(date)) return cache.get(date);
  if (!API_URL) throw new Error("Сервер для загрузки данных ещё не подключён.");
  const response = await fetch(`${API_URL}?date=${encodeURIComponent(date)}`, { cache: "no-store" });
  if (!response.ok) throw new Error("Setka Cup не ответил. Проверьте интернет и попробуйте ещё раз.");
  const tournaments = parseTournaments(await response.json())
    .sort((a, b) => a.dayPeriodToken - b.dayPeriodToken || tournamentTitle(a).localeCompare(tournamentTitle(b), "ru"));
  cache.set(date, tournaments);
  return tournaments;
}

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

// --- Адрес страницы: ?date=…&hall=…&period=… или ?date=…&t=<id турнира> ---

function state() {
  const p = new URLSearchParams(location.search);
  const int = (name) => (p.has(name) ? Number.parseInt(p.get(name), 10) : null);
  return { date: p.get("date"), hall: int("hall"), period: int("period"), id: int("t"), test: p.get("test"), d: p.get("d"), stats: p.get("stats"), q: p.get("q") ?? "", help: p.has("help"),
    pay: p.has("pay"), from: p.get("from"), to: p.get("to"), train: p.get("train") };
}

/** Сколько шагов назад внутри страницы — чтобы «Назад» не уводил с сайта */
let depth = 0;

function go(params, { replace = false } = {}) {
  if (!replace) depth++;
  const query = new URLSearchParams(Object.entries(params).filter(([, v]) => v != null && v !== "")).toString();
  const url = query ? `?${query}` : location.pathname;
  history[replace ? "replaceState" : "pushState"](null, "", url);
  render();
}

window.addEventListener("popstate", () => {
  depth = Math.max(0, depth - 1);
  render();
});

// --- Отрисовка ---

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

let renderToken = 0;

async function render() {
  const token = ++renderToken;
  const s = state();
  try {
    if (s.help) {
      app.innerHTML = helpView();
      document.title = "Справка — Турнир";
    } else if (s.train != null) {
      await renderTrain(s, token);
      if (token !== renderToken) return;
    } else if (s.pay) {
      await renderPay(s, token);
      if (token !== renderToken) return;
    } else if (s.stats != null) {
      app.innerHTML = statsView(s);
      document.title = "Статистика случаев — Турнир";
    } else if (s.test) {
      renderTest(s);
    } else if (s.date && s.id != null) {
      app.innerHTML = loadingTournament();
      const t = (await loadDay(s.date)).find((x) => x.id === s.id);
      if (token !== renderToken) return;
      app.innerHTML = t ? tournamentView(t, s.date) : home(s, { message: "Такого турнира в этот день нет." });
      document.title = t ? `${tournamentTitle(t)} — Турнир` : "Турнир — места Setka Cup";
    } else if (s.date && (s.hall != null || s.period != null)) {
      app.innerHTML = home(s, { loading: true });
      const found = (await loadDay(s.date)).filter((t) => matchesLink(t, s));
      if (token !== renderToken) return;
      if (found.length === 1) return go({ date: s.date, t: found[0].id }, { replace: true });
      app.innerHTML = home(s, { linkMatches: found });
    } else {
      const date = s.date ?? today();
      app.innerHTML = home({ ...s, date }, { loading: true });
      const tournaments = await loadDay(date);
      if (token !== renderToken) return;
      app.innerHTML = home({ ...s, date }, { tournaments });
      document.title = "Турнир — места Setka Cup";
    }
  } catch (error) {
    if (token !== renderToken) return;
    app.innerHTML = home({ ...s, date: s.date ?? today() }, { message: error.message });
  }
  bind();
}

// --- 🎯 Тренировка: настоящий турнир Setka без мест — расставить самому, потом сверить с Setka ---

const TRAIN_LEVELS = {
  normal: { title: "Обычный", about: "Очки разные или двое равных — решает личная встреча" },
  hard: { title: "Средний", about: "Трое и больше с равными очками: встречи между собой, партии, мячи" },
  unfair: { title: "Сложный", about: "Технические победы, снятия, «L : L», не было встречи, полное равенство" },
  unfairPlus: { title: "Нечестный +", about: "" },
};
const train = { level: null, t: null, date: null, order: [], checked: false, hint: false, ratios: false, revealed: false, counted: false, error: null };

function trainScores() {
  try { return JSON.parse(localStorage.getItem("trainScores") ?? "{}"); } catch { return {}; }
}

function saveTrainScore(level, solved, hinted) {
  const all = trainScores();
  const x = all[level] ?? { solved: 0, total: 0, hinted: 0 };
  x.total += 1;
  if (solved) x.solved += 1;
  if (hinted) x.hinted += 1;
  all[level] = x;
  try { localStorage.setItem("trainScores", JSON.stringify(all)); } catch { /* приватный режим */ }
}

/** Уровень турнира или null — не годится (не закрыт, нет итогов Setka) */
function trainKind(t) {
  if (!isFinished(t) || !t.setka.hasFinal) return null;
  const s = standings(t);
  return trainLevel(t, s, setkaDifference(t, s));
}

/** Набор турниров для тренировки: по 100 на уровень (в «Нечестном +» — сколько есть), выбраны по всему году */
let trainPool = null;
const loadTrainPool = async () => {
  if (!trainPool) {
    const response = await fetch("train-pool.json?v=1");
    if (!response.ok) throw new Error("Не удалось загрузить набор турниров — проверьте интернет.");
    trainPool = await response.json();
  }
  return trainPool;
};

/** Какие турниры уровня уже решались — сначала даются нерешённые */
function trainPlayed() {
  try { return JSON.parse(localStorage.getItem("trainPlayed") ?? "{}"); } catch { return {}; }
}

function markTrainPlayed(level, id) {
  const all = trainPlayed();
  all[level] = [...new Set([...(all[level] ?? []), id])];
  try { localStorage.setItem("trainPlayed", JSON.stringify(all)); } catch { /* приватный режим */ }
}

const tournamentsNoun = (n) => (n % 10 === 1 && n % 100 !== 11 ? "турнир" : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? "турнира" : "турниров");

/** « · 100 турниров, пройдено 12» */
function trainCount(level) {
  const n = trainPool?.[level]?.length;
  if (!n) return "";
  const done = (trainPlayed()[level] ?? []).length;
  return ` · ${n} ${tournamentsNoun(n)}${done ? `, пройдено ${Math.min(done, n)}` : ""}`;
}

const randomItem = (list) => list[Math.floor(Math.random() * list.length)];

/** Турнир из набора уровня: сначала те, что ещё не решались; все решены — любой */
async function pickTrainTournament(level, exceptId = null) {
  const pool = (await loadTrainPool())[level] ?? [];
  const played = new Set(trainPlayed()[level] ?? []);
  const fresh = pool.filter(([, id]) => !played.has(id) && id !== exceptId);
  const [date, id] = randomItem(fresh.length ? fresh : pool.filter(([, x]) => x !== exceptId).length ? pool.filter(([, x]) => x !== exceptId) : pool);
  const t = (await loadDay(date)).find((x) => x.id === id);
  if (!t) throw new Error("Setka не отдала этот турнир — нажмите «Ещё раз».");
  return { t, date };
}

async function renderTrain(s, token) {
  const level = TRAIN_LEVELS[s.train] ? s.train : null;
  if (!level) {
    try { await loadTrainPool(); } catch { /* меню покажется и без чисел */ }
    if (token !== renderToken) return;
    app.innerHTML = trainView(null);
    document.title = "Тренировка — Турнир";
    return;
  }
  if (train.level !== level || !train.t) {
    const previousId = train.t?.id ?? null;
    Object.assign(train, { level, t: null, date: null, order: [], checked: false, hint: false, ratios: false, revealed: false, counted: false, error: null });
    app.innerHTML = trainView(level);
    bind();
    try {
      const picked = await pickTrainTournament(level, previousId);
      if (token !== renderToken) return;
      Object.assign(train, picked);
    } catch (error) {
      if (token !== renderToken) return;
      train.error = error.message;
    }
  }
  app.innerHTML = trainView(level);
  document.title = "Тренировка — Турнир";
}

/** Игроки в нейтральном порядке — как впервые встречаются в расписании, а не по местам */
function trainPlayers(t) {
  const seen = new Map();
  for (const m of [...t.matches].sort((a, b) => a.position - b.position)) {
    for (const p of [m.player1, m.player2]) if (p && !seen.has(p.id)) seen.set(p.id, p);
  }
  return [...seen.values()];
}

/** Шахматка без мест: в клетке счёт по партиям глазами игрока строки */
function trainGrid(t, s, players) {
  const cells = new Map();
  for (const m of s.groupMatches) {
    if (!m.player1 || !m.player2) continue;
    const g = game(m), a = m.player1.id, b = m.player2.id;
    // side: игрок строки был в матче слева (красный) или справа (синий) — как точки в списке матчей
    const put = (x, y, text, cls) => cells.set(`${x}-${y}`, `<span class="side-dot ${x === a ? "red" : "blue"}"></span><span class="${cls}">${esc(text)}</span>`);
    if (g?.doubleLoss) { put(a, b, "L:L", "loss"); put(b, a, "L:L", "loss"); }
    else if (g) {
      const mark = g.walkover ? " тех." : "";
      put(a, b, `${g.s1}:${g.s2}${mark}`, g.winner === a ? "win" : "loss");
      put(b, a, `${g.s2}:${g.s1}${mark}`, g.winner === b ? "win" : "loss");
    } else { put(a, b, "не сост.", "wait"); put(b, a, "не сост.", "wait"); }
  }
  const points = new Map(s.rows.map((r) => [r.player.id, r.record.points]));
  const records = new Map(s.rows.map((r) => [r.player.id, r.record]));
  // «Коэффициенты»: партии и мячи за весь турнир, выиграно ÷ проиграно
  const coef = (won, lost) => `${won}:${lost}<div class="train-ratio">${lost ? (won / lost).toFixed(3).replace(".", ",") : won ? "∞" : "—"}</div>`;
  return `
    <table class="cross">
      <thead><tr><th class="name">Игрок</th>${players.map((p, i) => `<th>${i + 1}</th>`).join("")}${train.ratios ? "<th>Партии</th><th>Мячи</th>" : ""}${train.hint ? "<th>Очки</th>" : ""}</tr></thead>
      <tbody>
        ${players.map((p, i) => `
          <tr>
            <th class="name"><span class="num">${i + 1}</span>${esc(p.lastName)}</th>
            ${players.map((q) => (p.id === q.id ? `<td class="self">●</td>` : `<td>${cells.get(`${p.id}-${q.id}`) ?? ""}</td>`)).join("")}
            ${train.ratios ? `<td class="train-coef">${coef(records.get(p.id).setsWon, records.get(p.id).setsLost)}</td><td class="train-coef">${coef(records.get(p.id).ballsWon, records.get(p.id).ballsLost)}</td>` : ""}
            ${train.hint ? `<td class="points">${points.get(p.id) ?? 0}</td>` : ""}
          </tr>`).join("")}
      </tbody>
    </table>`;
}

/** Верное место по Setka: у неё бывает несколько вариантов поля — подходит любой */
const setkaPlaces = (t, id) => [...new Set(t.setka.places.get(id) ?? [])];

function trainView(level) {
  const scores = trainScores();
  const tabs = `
    <div class="train-levels">
      ${Object.entries(TRAIN_LEVELS).map(([key, x]) => {
        const sc = scores[key];
        // Сколько турниров уровня в базе — из справочника, обновляется раз в неделю
        return `<button class="${key === level ? "" : "outline"} small" data-action="train-level" data-level="${key}">
          ${esc(x.title)}${sc ? ` <span class="train-score">${sc.solved}/${sc.total}</span>` : ""}</button>`;
      }).join("")}
    </div>`;
  const top = `
    <div class="topbar">
      <div class="side"><button class="ghost" data-action="back">‹ Назад</button></div>
      <h2>🎯 Тренировка</h2>
      <div class="side end"></div>
    </div>
    ${tabs}`;
  if (!level) {
    return `${top}
      <div class="card pad">
        <p>Настоящий турнир Setka Cup без мест и очков. Посчитайте сами, расставьте игроков по местам и сверьте с официальным итогом Setka.</p>
        ${Object.entries(TRAIN_LEVELS).map(([key, x]) => `<p class="muted"><b>${esc(x.title)}</b>${trainCount(key)}${x.about ? ` — ${esc(x.about)}` : ""}</p>`).join("")}
        ${trainPool ? `<p class="muted">Турниры выбраны случайно по всему году: с ${esc(shortDate(trainPool.from))}.${esc(trainPool.from.slice(2, 4))} по ${esc(shortDate(trainPool.to))}.${esc(trainPool.to.slice(2, 4))}. Сначала даются те, что вы ещё не решали.</p>` : ""}
        <p class="muted">Счёт «решено / всего» хранится на этом телефоне.</p>
      </div>
      ${footer()}`;
  }
  if (train.error) return `${top}<p class="note error">${esc(train.error)}</p><div class="actions"><button data-action="train-next">Ещё раз</button></div>${footer()}`;
  if (!train.t) return `${top}<div class="center"><span class="spinner"></span></div>`;

  const t = train.t;
  const s = standings(t);
  const players = trainPlayers(t);
  const n = players.length;
  const placeOf = new Map(train.order.map((id, i) => [id, i + 1]));
  const correct = (id) => setkaPlaces(t, id).includes(placeOf.get(id));
  const allRight = train.checked && players.every((p) => correct(p.id));
  const sc = scores[level];
  return `${top}
    ${[TRAIN_LEVELS[level].about, sc ? `решено ${sc.solved} из ${sc.total}${sc.hinted ? `, с подсказкой ${sc.hinted}` : ""}` : ""].some(Boolean)
      ? `<p class="muted train-about">${esc([TRAIN_LEVELS[level].about, sc ? `решено ${sc.solved} из ${sc.total}${sc.hinted ? `, с подсказкой ${sc.hinted}` : ""}` : ""].filter(Boolean).join(" · "))}</p>` : ""}
    ${trainPool?.[level] ? `<p class="muted train-about">Пройдено ${Math.min((trainPlayed()[level] ?? []).length, trainPool[level].length)} из ${trainPool[level].length}</p>` : ""}
    <div class="section-title with-action">
      <span>${train.revealed ? esc(`${tournamentTitle(t)} · ${shortDate(train.date)}`) : `Турнир · ${n} ${playersNoun(n)}`}</span>
      <button class="outline small" data-action="train-hint" ${train.hint ? "disabled" : ""}>${train.hint ? "Очки показаны" : "Подсказка: очки"}</button>
    </div>
    ${level === "normal" ? `
      <div class="actions train-tools">
        <button class="outline small toggle" data-action="train-ratios" aria-pressed="${train.ratios}">Коэффициенты</button>
      </div>` : ""}
    <div class="card cross-wrap">${trainGrid(t, s, players)}</div>
    <p class="note">Победа — 2 очка, поражение — 1, техническое поражение и «L : L» — 0.</p>
    <details class="card pad train-sets">
      <summary>Счёт по партиям — для мячей</summary>
      ${s.hasPlacementMatches ? `<h3>Финал и матч за 3-е место</h3>${s.placementMatches.map((m) => matchRow(m, true, new Map())).join("")}<h3>Группа</h3>` : ""}
      ${s.groupMatches.map((m) => matchRow(m, true, new Map())).join("")}
    </details>
    <div class="section-title">Ваши места — нажимайте с 1-го</div>
    <div class="card">
      ${players.map((p) => {
        const place = placeOf.get(p.id);
        const mark = !train.checked ? "" : correct(p.id) ? `<span class="train-ok">✓</span>` : `<span class="train-bad">✗ ${setkaPlaces(t, p.id).join(" или ")}</span>`;
        return `<button class="train-player row" data-action="train-pick" data-player="${p.id}" ${train.checked ? "disabled" : ""}>
          <span class="train-place ${place ? "set" : ""}">${place ?? ""}</span><span class="grow">${esc(fullName(p))}</span>${mark}</button>`;
      }).join("")}
    </div>
    ${train.checked ? `
      <div class="card pad ${allRight ? "train-win" : "warn"}" style="margin-top:8px">
        <h3>${allRight ? "✅ Верно! Места совпали с Setka" : `❌ Ошибок: ${players.filter((p) => !correct(p.id)).length}`}</h3>
        ${allRight ? "" : `<p class="muted">Справа у неверных — место по итогам Setka.</p>`}
      </div>` : ""}
    <div class="actions">
      ${train.checked ? `
        <button class="outline" data-action="train-reveal">${train.revealed ? "Скрыть результат" : "Результат Setka"}</button>
        <button data-action="train-next">Следующий турнир</button>` : `
        <button class="outline" data-action="train-reset" ${train.order.length ? "" : "disabled"}>Сбросить</button>
        <button data-action="train-check" ${train.order.length === n ? "" : "disabled"}>Проверить</button>`}
    </div>
    ${train.checked && !train.revealed ? `<p class="note"><a class="accent-link" href="#" data-action="train-reveal">Результат Setka</a> — официальные места и разбор, почему так.</p>` : ""}
    ${train.revealed ? trainReveal(t, s) : ""}
    ${footer()}`;
}

/** Официальные места Setka, наш расчёт и разбор равенств */
function trainReveal(t, s) {
  const official = [...s.rows].sort((a, b) => Math.min(...setkaPlaces(t, a.player.id), 99) - Math.min(...setkaPlaces(t, b.player.id), 99));
  const differs = s.rows.some((r) => !setkaPlaces(t, r.player.id).includes(r.place));
  return `
    <div class="section-title">Итог Setka</div>
    <div class="card">
      ${official.map((r) => `
        <div class="final-row row">${place(Math.min(...setkaPlaces(t, r.player.id)))}<span class="grow">${esc(fullName(r.player))}</span>
          <span class="muted">${r.record.points} оч.${differs && !setkaPlaces(t, r.player.id).includes(r.place) ? ` · у нас ${r.place}` : ""}</span></div>`).join("")}
    </div>
    ${differs ? `<p class="note footnote">Здесь места Setka расходятся с подсчётом по правилам («у нас» — как по правилам). Засчитывается вариант Setka.</p>` : ""}
    ${s.ties.length ? `
      <div class="section-title">Почему так</div>
      <div class="card pad">
        ${s.ties.map((tie) => `
          <div class="tie"><h3>${esc(tie.title)}</h3>
            <ul>${tie.lines.map((line) => `<li>${esc(line[0].toUpperCase() + line.slice(1))}</li>`).join("")}</ul></div>`).join("")}
      </div>` : `<p class="note">Равных по очкам нет — места просто по очкам.</p>`}
    <p class="note">
      <a class="accent-link" href="${esc(setkaLink(train.date, t.locationId, t.dayPeriodToken))}" target="_blank" rel="noopener">Официальный результат на Setka Cup ↗</a>
      · <a class="accent-link" href="?date=${esc(train.date)}&t=${t.id}" data-action="open" data-date="${esc(train.date)}" data-id="${t.id}">Наш расчёт целиком ›</a>
    </p>`;
}

// --- 💰 Зарплата игрока за период ---

const money = (n) => `${n.toLocaleString("ru-RU")} ${PAY.currency}`;
const dayMonth = (iso) => new Date(`${iso}T12:00:00`).toLocaleDateString("ru-RU", { day: "numeric", month: "long" });
const validIso = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);

/** Период из адреса; без дат — последняя наступившая выплата */
function payPeriod(s) {
  if (validIso(s.from) && validIso(s.to) && s.from <= s.to) {
    const p = periodFor(s.from);
    const regular = p.from === s.from && p.to === s.to;
    return { from: s.from, to: s.to, payout: regular ? p.payout : null };
  }
  return lastPayoutPeriod(today());
}

async function renderPay(s, token) {
  const period = payPeriod(s);
  const days = daysBetween(period.from, period.to).filter((d) => d <= today());
  app.innerHTML = payView(period, null);
  bind();
  const load = (list) => Promise.all(list.map(async (date) => ({ date, tournaments: await loadDay(date) })));
  const last = lastPayout();
  const unpaidDays = last ? daysBetween(last.unpaidFrom, today()) : [];
  const [loaded, unpaid] = await Promise.all([load(days), load(unpaidDays)]);
  if (token !== renderToken) return;
  app.innerHTML = payView(period, payroll(loaded), last && { last, result: payroll(unpaid) });
  document.title = "Зарплата — Турнир";
}

/** «Ещё не оплачено» после последней записанной выплаты и список пришедших выплат со сверкой */
function payoutsBlock(unpaid) {
  if (!unpaid) return "";
  const { last, result } = unpaid;
  const diff = (p) => {
    if (p.accrued == null) return "";
    const d = Math.round((p.amount - p.accrued) * 100) / 100;
    return `<span class="${d < -1 ? "pay-short" : "muted"}">${d >= 0 ? "+" : "−"}${Math.abs(d).toLocaleString("ru-RU")}</span>`;
  };
  return `
    <div class="card pad pay-unpaid">
      <h3>⏳ Ещё не оплачено</h3>
      <div class="pay-sum">${esc(money(result.total))}</div>
      <div class="muted">турниры с ${esc(dayMonth(last.unpaidFrom))} · ${result.rows.length} шт.${result.rows.some((r) => r.live) ? " · есть незакрытый у Setka" : ""}</div>
      <div class="pay-lines">
        ${result.rows.map((r) => `<div class="pay-line"><span>${esc(dayMonth(r.date))} · ${esc(tournamentTitle(r.t))}</span><b>${esc(money(r.total))}</b></div>`).join("")}
      </div>
    </div>
    <details class="card pad pay-history">
      <summary>Пришедшие выплаты · ${PAY.payouts.length}</summary>
      <div class="pay-lines">
        ${[...PAY.payouts].reverse().map((p) => `
          <div class="pay-line"><span>${esc(dayMonth(p.date))}<span class="muted"> · по ${esc(dayMonth(p.upTo))}</span></span>${diff(p)}<b>${p.amount.toLocaleString("ru-RU", { minimumFractionDigits: 2 })}</b></div>`).join("")}
      </div>
      <p class="note">Справа от суммы — разница с начисленным по турнирам. Плюс в несколько гривен — курсовая разница, недостачи были бы красным.</p>
    </details>`;
}

function payView(period, result, unpaid = null) {
  const current = periodFor(today());
  const isCurrent = period.from === current.from && period.to === current.to;
  const title = period.payout
    ? `Выплата ${dayMonth(period.payout)}${isCurrent ? " (ещё идёт)" : ""}`
    : "Свои даты";
  const line = (label, count, rate, sum) => `
    <div class="pay-line"><span>${esc(label)}</span><span class="muted">${count} × ${esc(money(rate))}</span><b>${esc(money(sum))}</b></div>`;
  const entryLines = result ? [...result.byPeriod].map(([name, count]) => {
    const rate = PAY.entry[name];
    return rate == null
      ? `<div class="pay-line"><span>${esc(name || "Другие")} — ставка не задана</span><span class="muted">${count}</span><b>0 ${PAY.currency}</b></div>`
      : line(`Выход: ${name}`, count, rate, count * rate);
  }).join("") : "";
  return `
    <div class="topbar">
      <div class="side"><button class="ghost" data-action="back">‹ Назад</button></div>
      <h2>💰 Зарплата</h2>
      <div class="side end"></div>
    </div>
    <p class="tournament-date">${esc(PAY.playerName)}</p>
    <div class="card pad pay-period">
      <div class="pay-nav">
        <button class="ghost icon" data-action="pay-prev" aria-label="Предыдущая выплата">‹</button>
        <div class="pay-title">
          <b>${esc(title)}</b>
          <div class="muted">за ${esc(dayMonth(period.from))} — ${esc(dayMonth(period.to))}</div>
        </div>
        <button class="ghost icon" data-action="pay-next" aria-label="Следующая выплата"${period.payout && period.from >= current.from ? " disabled" : ""}>›</button>
      </div>
      <div class="pay-custom">
        <input type="date" id="pay-from" value="${esc(period.from)}" aria-label="С">
        <span>—</span>
        <input type="date" id="pay-to" value="${esc(period.to)}" aria-label="По">
        <button class="outline small" data-action="pay-custom">Посчитать</button>
      </div>
    </div>
    ${payoutsBlock(unpaid)}
    ${result ? `
      <div class="section-title">Выбранный период</div>
      <div class="card pad pay-total">
        <div class="pay-sum">${esc(money(result.total))}</div>
        <div class="muted">${result.rows.length} ${result.rows.length === 1 ? "турнир" : result.rows.length < 5 && result.rows.length > 1 ? "турнира" : "турниров"} · побед ${result.wins + result.walkoverWins} · поражений ${result.losses}</div>
        <div class="pay-lines">
          ${entryLines}
          ${line("Победы", result.wins, PAY.win, result.wins * PAY.win)}
          ${result.walkoverWins ? line("Технические победы", result.walkoverWins, PAY.walkoverWin, result.walkoverWins * PAY.walkoverWin) : ""}
        </div>
        ${result.rows.some((r) => r.live) ? `<p class="note">Есть турнир, который ещё идёт, — сумма может вырасти.</p>` : ""}
      </div>
      <div class="section-title">Турниры</div>
      <div class="card">
        ${result.rows.length ? result.rows.map((r) => `
          <a class="row pay-row" href="?date=${esc(r.date)}&t=${r.t.id}" data-action="open" data-date="${esc(r.date)}" data-id="${r.t.id}">
            <div class="pay-row-main">
              <div><b>${esc(tournamentTitle(r.t))}</b>${r.live ? ` <span class="badge live">идёт</span>` : ""}</div>
              <div class="muted">${esc(dayMonth(r.date))} · побед ${r.wins}${r.walkoverWins ? ` + ${r.walkoverWins} тех.` : ""} · поражений ${r.losses}</div>
            </div>
            <b>${esc(money(r.total))}</b>
          </a>`).join("") : `<div class="center row">В эти дни турниров не было</div>`}
      </div>
      <p class="note">Выход: вечер — ${esc(money(PAY.entry["Вечер"]))}, ночь — ${esc(money(PAY.entry["Ночь"]))}. Победа — ${esc(money(PAY.win))}, техническая — ${esc(money(PAY.walkoverWin))}. Выплаты примерно ${PAY.payoutDays.join(", ")} числа — за дни с прошлой выплаты; если выплата была в другой день, задайте даты вручную.</p>`
    : `<div class="center"><span class="spinner"></span></div>`}
    ${footer()}`;
}

// --- 📖 Справка: что умеет сайт, по разделам ---

function helpView() {
  const section = (title, body) => `
    <div class="section-title">${title}</div>
    <div class="card pad help">${body}</div>`;
  return `
    <div class="topbar">
      <div class="side"><button class="ghost" data-action="back">‹ Назад</button></div>
      <h2>📖 Справка</h2>
      <div class="side end"></div>
    </div>
    <p class="note">Сайт считает места в турнирах Setka Cup по настольному теннису: по результатам матчей и правилам ITTF, с объяснением, почему игрок на своём месте. Это неофициальная страница: данные берутся с сайта Setka Cup.</p>

    ${section("Главная", `
      <h3>Ссылка на турнир</h3>
      <p>Откройте турнир в расписании Setka Cup, скопируйте ссылку из адресной строки (в ней есть дата, зал и время дня) и нажмите «Вставить» или вставьте её в поле и нажмите «Посчитать».</p>
      <h3>Список турниров</h3>
      <ul>
        <li>Выберите день — турниры этого дня сгруппированы по залам, внутри зала — по времени: утро, день, вечер, ночь.</li>
        <li>Сеул и Токио всегда сверху. За ними — залы, где турнир идёт прямо сейчас, потом остальные по алфавиту.</li>
        <li>Метки: «скоро» — турнир ещё не начался, «идёт · 8/15» — идёт, сыграно 8 матчей из 15. Без метки — турнир закрыт.</li>
      </ul>
      <h3>Кнопки сверху</h3>
      <p>📊 — статистика нестандартных случаев, 🧪 Тест — тестовый раздел, ? — эта справка.</p>`)}

    ${section("Страница турнира", `
      <h3>Таблица</h3>
      <ul>
        <li>Место, игрок, победы–поражения (В–П), партии, мячи и очки.</li>
        <li>Кнопка «Коэффициенты» показывает под партиями и мячами их коэффициент за весь турнир (выиграно ÷ проиграно). Места она не меняет: при равных очках решают коэффициенты только во встречах между этими игроками — они в «Почему так». Нажмите ещё раз, чтобы спрятать; выбор запоминается.</li>
        <li>Пометка «жребий» у игрока — он равен с соседом по всем показателям (см. «Правила подсчёта»).</li>
      </ul>
      <h3>Результаты встреч</h3>
      <p>Таблица, как на сайте Setka: строка — игрок, столбец — соперник, в клетке счёт по партиям глазами игрока строки. Номер слева — место. Победы выделены жирным.</p>
      <h3>Подсветка игрока</h3>
      <p>Нажмите на фамилию в таблице, в результатах встреч или в списке матчей — подсветятся его строка, столбец и матчи, остальные матчи станут бледнее. Нажмите ещё раз, чтобы снять.</p>
      <h3>Почему так</h3>
      <p>Для каждой группы игроков с равными очками — чем их развели: личная встреча, очки, партии или мячи во встречах между ними, с дробями. Если всё равно — коэффициент партий, затем мячей за весь турнир, и только потом жребий.</p>
      <h3>Итоговые места, финал и матч за 3-е место</h3>
      <p>Если в турнире были финал и матч за 3-е место, итоговые места 1–4 решают они, а в блоке «Группа» — места по группе.</p>
      <h3>Матчи группы</h3>
      <p>Все матчи по порядку со счётом каждой партии.</p>
      <h3>Кнопки</h3>
      <p>↻ вверху — загрузить свежий счёт. «Поделиться ссылкой» внизу — ссылка, которая сразу откроет этот турнир.</p>`)}

    ${section("Турнир ещё идёт", `
      <ul>
        <li>Сверху — «Результат не окончательный»: сколько матчей сыграно, какой идёт сейчас и какие ещё не сыграны. Таблица считается по сыгранным матчам; идущий матч в неё не входит, пока не закончится.</li>
        <li>«Посчитать с исходами» — выберите, чем могут закончиться несыгранные матчи, и нажмите «Пересчитать»: таблица покажет места при таком раскладе. Выбранные исходы помечены «*», их мячи не учитываются. «Сбросить» возвращает настоящую таблицу.</li>
        <li>Если турнир ещё не начался, показан список участников и матчей.</li>
      </ul>`)}

    ${section("Турнир закрыт, но матчи не доиграны", `
      <p>Блок «Не состоялись или не доиграны» перечисляет такие матчи и как они засчитаны — так же, как у Setka. Если у матча нет результата, «Посчитать с исходами» покажет места при любом его исходе.</p>`)}

    ${section("Правила подсчёта", `
      <h3>Очки</h3>
      <p>Победа — 2 очка, поражение — 1, техническое поражение (неявка) — 0.</p>
      <h3>Равенство очков</h3>
      <ol>
        <li>Двое и между ними одна встреча — выше победитель этой встречи.</li>
        <li>Трое и больше — считается мини-таблица только из их встреч друг с другом: сначала очки, затем соотношение партий, затем соотношение мячей. Дроби сравниваются точно, без округления.</li>
        <li>Как только кто-то выделился, оставшиеся равные снова сравниваются только между собой — с первого шага.</li>
        <li>Двое равных, а встречи между ними не было («L : L» или матч не сыгран) — выше тот, у кого лучше соотношение партий за весь турнир, при равенстве — мячей. Этого нет в правилах ITTF, но так Setka поступила во всех известных случаях за год.</li>
        <li>Если во встречах между собой равно всё — места по коэффициенту партий за весь турнир (выиграно ÷ проиграно), при равенстве — мячей. Это наше правило, чтобы места решала логика, а не случайность: у Setka порядок в таких случаях бывает произвольным.</li>
        <li>Если равен и общий коэффициент — жребий. Угадать его нельзя, поэтому порядок берётся из итогов Setka; пока итогов нет, он условный.</li>
      </ol>
      <p>Это правила ITTF. Проверено на всех турнирах Setka за год: места совпали в 11 859 турнирах из 11 863. Если официальные места Setka отличаются от расчёта, под таблицей будет сноска, как у Setka.</p>
      <h3>Финал и матч за 3-е место</h3>
      <p>Победитель финала — 1-й, проигравший — 2-й; матч за 3-е место — так же для 3–4 мест. Если финал или матч за 3-е место не состоялся, места остаются по группе.</p>`)}

    ${section("Необычные случаи", `
      <ul>
        <li><b>Неявка</b> — техническая победа сопернику: 2 очка и 3:0 (11:0 в каждой партии), неявившемуся 0 очков.</li>
        <li><b>Игрок снялся</b> — все его оставшиеся матчи засчитываются как неявки, уже сыгранные остаются.</li>
        <li><b>«L : L»</b> — матч не состоялся по вине обоих: обоим поражение и 0 очков.</li>
        <li><b>Матч прерван</b> — техническая победа, мячи сыгранных партий тоже идут в зачёт.</li>
      </ul>
      <h3>Похожие случаи</h3>
      <p>Если в турнире есть такая ситуация, внизу страницы появится блок «Похожие случаи»: как Setka считала её раньше, сколько раз это встречалось и ссылки на такие турниры. Справочник обновляется сам раз в неделю.</p>`)}

    ${section("📊 Статистика", `
      <p>Все нестандартные турниры Setka за последний год: неявки, снятия, «L : L», прерванные матчи, несостоявшиеся финалы, жребий и расхождения с Setka.</p>
      <ul>
        <li>Фильтр по виду случая и поиск по фамилии или залу.</li>
        <li>У каждого случая — ссылка на турнир на Setka Cup и на наш расчёт.</li>
        <li>«Скачать CSV» — весь список таблицей для Excel или Google Таблиц.</li>
      </ul>
      <div class="actions"><button class="outline small" data-action="stats-open">Открыть статистику</button></div>`)}

    ${section("🧪 Тестовый раздел", `
      <p>Цель этого раздела — не подтверждение ваших результатов, а проверка логики приложения на излом и выявление погрешностей с помощью различных манипуляций.</p>
      <ul>
        <li>Задайте от 3 до 8 игроков и результаты матчей: счёт, техническую победу, «L : L» или «не сыгран». Счёт партий можно указать — тогда учтутся и мячи.</li>
        <li>«Заполнить случайно» — случайные результаты, «Посчитать» — таблица, как у настоящего турнира.</li>
        <li>Тест хранится в ссылке — её можно отправить или открыть позже.</li>
      </ul>
      <div class="actions"><button class="outline small" data-action="test-open">Открыть тестовый раздел</button></div>`)}

    ${section("Откуда данные", `
      <ul>
        <li>Результаты матчей берутся с сайта Setka Cup через небольшой сервер-посредник — при открытии страницы и по кнопке ↻. Счёт может отставать от Setka до 15 секунд.</li>
        <li>Места сайт считает сам. У Setka берётся только порядок при жребии.</li>
        <li>Страница неофициальная: при спорах решают организаторы турнира.</li>
      </ul>`)}
    ${footer()}`;
}

// --- 🧪 Тест: свой турнир для проверки логики ---

/** Черновик редактора — живёт, пока открыта страница */
let testDraft = null;

function renderTest(s) {
  const data = s.d ? decode(s.d) : null;
  if (s.test === "view" && data) {
    testDraft = data;
    app.innerHTML = tournamentView(buildTournament(data));
    document.title = "Тестовый раздел — Турнир";
    return;
  }
  testDraft = data ?? testDraft ?? emptyTest();
  app.innerHTML = testEditor(testDraft, s.test === "view" ? "Не получилось прочитать тест из ссылки." : "");
  document.title = "Тест — Турнир";
}

function testEditor(data, message = "") {
  const names = data.players.map((name, i) => name.trim() || `Игрок ${i + 1}`);
  const list = pairs(data.players.length);
  return `
    <div class="topbar">
      <div class="side"><button class="ghost" data-action="back">‹ Назад</button></div>
      <h2>🧪 Тестовый раздел</h2>
      <div class="side end"></div>
    </div>
    <p class="note footnote">Цель этого раздела — не подтверждение ваших результатов, а проверка логики приложения на излом и выявление погрешностей с помощью различных манипуляций.</p>
    <p class="note">Введите игроков и результаты — места посчитаются так же, как для турниров Setka. Пробуйте необычные ситуации: равенства, неявки, «L : L».</p>
    ${message ? `<p class="note error">${esc(message)}</p>` : ""}
    <div class="section-title">Игроки · ${data.players.length}</div>
    <div class="card pad">
      ${data.players.map((name, i) => `
        <div class="test-player">
          <span class="place">${i + 1}</span>
          <input type="text" data-player="${i}" value="${esc(name)}" placeholder="Игрок ${i + 1}" maxlength="24" autocomplete="off">
          ${data.players.length > MIN_PLAYERS ? `<button class="ghost icon" data-action="test-remove" data-index="${i}" aria-label="Убрать игрока">✕</button>` : ""}
        </div>`).join("")}
      ${data.players.length < MAX_PLAYERS ? `<button class="outline small" data-action="test-add">+ Игрок</button>` : ""}
    </div>
    <div class="section-title">Матчи · ${list.length}</div>
    <div class="card">
      ${list.map(([a, b]) => {
        const key = pairKey(a, b);
        const { r = "", sets = "" } = data.results[key] ?? {};
        const label = (text) => text.replace("A", names[a]).replace("B", names[b]);
        return `
          <div class="test-match row">
            <div class="test-pair">${esc(names[a])} — ${esc(names[b])}</div>
            <div class="test-inputs">
              <select data-result="${key}">
                ${RESULTS.map(([value, text]) => `<option value="${value}" ${value === r ? "selected" : ""}>${esc(label(text))}</option>`).join("")}
              </select>
              <input type="text" data-sets="${key}" value="${esc(sets)}" placeholder="партии: 11:7 9:11 11:5" inputmode="numbers" autocomplete="off">
            </div>
            <div class="hint error" data-mismatch="${key}" ${setsMismatch(r, sets) ? "" : "hidden"}>Партии не сходятся со счётом — в расчёт пойдут мячи из партий, а счёт — выбранный.</div>
          </div>`;
      }).join("")}
    </div>
    <p class="note">Партии необязательны: без них мячи считаются нулями, а места решают очки и партии.</p>
    <label class="test-toggle"><input type="checkbox" id="test-closed" ${data.closed ? "checked" : ""}> Турнир закрыт — несыгранные матчи «не состоялись»</label>
    <div class="actions test-actions">
      <button class="outline small" data-action="test-random">Заполнить случайно</button>
      <button class="outline small" data-action="test-clear">Очистить</button>
      <button data-action="test-run">Посчитать</button>
    </div>
    ${footer()}`;
}

/** Данные из полей редактора → черновик */
function readEditor() {
  const players = [...app.querySelectorAll("[data-player]")].map((input) => input.value);
  const results = {};
  for (const select of app.querySelectorAll("[data-result]")) {
    const key = select.dataset.result;
    const sets = app.querySelector(`[data-sets="${key}"]`)?.value.trim() ?? "";
    if (select.value || sets) results[key] = { r: select.value, sets };
  }
  testDraft = { players, results, closed: app.querySelector("#test-closed")?.checked ?? true };
  return testDraft;
}

function showEditor() {
  app.innerHTML = testEditor(testDraft);
  bind();
}

/** Убрать игрока: результаты остальных пар сохраняются, номера сдвигаются */
function removePlayer(data, index) {
  const shift = (i) => (i > index ? i - 1 : i);
  const results = {};
  for (const [key, value] of Object.entries(data.results)) {
    const [a, b] = key.split("-").map(Number);
    if (a !== index && b !== index) results[pairKey(shift(a), shift(b))] = value;
  }
  return { ...data, players: data.players.filter((_, i) => i !== index), results };
}

function loadingTournament() {
  return `
    <div class="topbar"><div class="side"><button class="ghost" data-action="back">‹ Назад</button></div><h2></h2><div class="side end"></div></div>
    <div class="center"><span class="spinner"></span></div>`;
}

function home(s, { tournaments, linkMatches, loading, message } = {}) {
  const date = s.date ?? today();
  return `
    <div class="title-row">
      <h1>Турнир</h1>
      <button class="outline small" data-action="train-open" title="Тренировка: расставьте места сами">🎯</button>
      <button class="outline small" data-action="stats-open" title="Нестандартные случаи за год">📊</button>
      <button class="outline small" data-action="test-open" title="Тестовый раздел: попробовать сломать логику подсчёта">🧪 Тест</button>
      <button class="outline small" data-action="help-open" title="Справка" aria-label="Справка">?</button>
    </div>
    <div class="section-title">Ссылка на турнир</div>
    <div class="card pad">
      <textarea id="link" rows="2" placeholder="setkacup.com/ru/schedule?date=…" autocapitalize="off" autocorrect="off" spellcheck="false"></textarea>
      <div class="actions">
        <button class="outline" data-action="paste">Вставить</button>
        <button data-action="open-link">Посчитать</button>
      </div>
    </div>
    <p class="note">Скопируйте ссылку со страницы расписания Setka Cup — с датой, залом и временем дня.</p>
    ${message ? `<p class="note error">${esc(message)}</p>` : ""}
    ${linkMatches ? `
      <div class="section-title">По ссылке</div>
      <div class="card">
        ${linkMatches.length ? linkMatches.map((t) => tournamentRow(t, date)).join("") : `<div class="center">В этот день такого турнира нет</div>`}
      </div>` : ""}
    <div class="section-title">Или выберите из списка</div>
    <div class="card">
      <div class="day-row row"><span>День</span><input type="date" id="day" value="${esc(date)}"></div>
      ${loading ? `<div class="center row"><span class="spinner"></span></div>` : ""}
      ${tournaments && !tournaments.length ? `<div class="center row">Турниров нет</div>` : ""}
    </div>
    ${csvLink()}
    <p class="note"><a href="?help=1" data-action="help-open">📖 Справка</a> — что умеет сайт и как он считает места</p>
    ${halls(tournaments ?? []).map((hall) => `
      <div class="section-title hall">${esc(hall.name)}${hall.live ? ` <span class="badge live">идёт</span>` : ""}</div>
      <div class="card">
        ${hall.tournaments.map((t) => tournamentRow(t, date, hall.mixed)).join("")}
      </div>`).join("")}
    ${footer()}`;
}

function csvLink() {
  if (!precedents) return "";
  const count = Object.keys(precedents.tournaments).length;
  return `<p class="note"><a href="?stats=all" data-action="stats-open">📊 Статистика нестандартных случаев</a> — ${count} турниров за ${period()}, со ссылками на Setka Cup и выгрузкой в CSV</p>`;
}

/** «08.10.25–07.10.26» */
const period = () =>
  `${shortDate(precedents.from)}.${precedents.from.slice(2, 4)}–${shortDate(precedents.to)}.${precedents.to.slice(2, 4)}`;

// --- 📊 Статистика: база нестандартных случаев за год (precedents.json) ---

/** Сколько случаев показывать в списке; «Показать ещё» добавляет */
let statsLimit = 50;

function statsView(s) {
  const top = `
    <div class="topbar">
      <div class="side"><button class="ghost" data-action="back">‹ Назад</button></div>
      <h2>📊 Статистика</h2>
      <div class="side end"></div>
    </div>`;
  if (!precedents) return `${top}<div class="center"><span class="spinner"></span></div>`;

  const all = Object.entries(precedents.tournaments)
    .map(([id, t]) => ({ id: Number(id), ...t }))
    .sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id);
  const filter = s.stats === "all" ? "" : s.stats;
  const query = s.q.trim().toLowerCase();
  const list = all.filter((c) =>
    (!filter || c.situations.includes(filter)) &&
    (!query || `${c.title} ${Object.values(c.details ?? {}).join(" ")}`.toLowerCase().includes(query)));
  const checked = all.filter((c) => c.setka != null);
  const confirmed = checked.filter((c) => c.setka).length;
  const titles = Object.fromEntries(SITUATIONS.map((x) => [x.key, x.title]));

  return `
    ${top}
    <div class="card pad stats-head">
      <div class="stats-big">${all.length}<span>нестандартных турниров</span></div>
      <p>За ${period()} просмотрено ${precedents.scanned?.toLocaleString("ru") ?? "—"} закрытых турниров Setka Cup.
        Места, посчитанные по правилам ITTF, совпали с официальными в ${confirmed} из ${checked.length} нестандартных турниров.
        Обновляется само каждый понедельник.</p>
      <button class="outline small" data-action="download-csv">⬇ Скачать CSV</button>
    </div>

    <div class="section-title">По видам</div>
    <div class="card">
      ${SITUATIONS.map((x) => {
        const st = precedents.situations[x.key] ?? { total: 0, confirmed: 0, mismatched: 0 };
        const active = filter === x.key;
        return `
          <button class="stat-row row ${active ? "active" : ""}" data-action="stats-filter" data-key="${active ? "all" : x.key}">
            <span class="info">
              <span class="name">${esc(x.title)}</span><br>
              ${active ? `<span class="sub">${esc(x.conclusion)}</span><br>` : ""}
              <span class="sub">${x.key === "setkaDiffers" ? "исключения из правил" : `совпало с Setka: ${st.confirmed} из ${st.confirmed + st.mismatched}`}</span>
            </span>
            <span class="stat-count">${st.total}</span>
          </button>`;
      }).join("")}
    </div>

    <div class="section-title">${filter ? esc(titles[filter]) : "Все случаи"} · ${list.length}</div>
    <div class="stats-search">
      <input type="search" id="stats-q" value="${esc(s.q)}" placeholder="Поиск: фамилия или зал" autocomplete="off">
      ${filter ? `<button class="outline small" data-action="stats-filter" data-key="all">Все виды</button>` : ""}
    </div>
    <div class="card">
      ${list.length ? list.slice(0, statsLimit).map((c) => caseRow(c, titles, filter)).join("") : `<div class="center">Ничего не найдено</div>`}
    </div>
    ${list.length > statsLimit ? `<div class="actions" style="justify-content:center;margin-top:12px">
      <button class="outline" data-action="stats-more">Показать ещё · осталось ${list.length - statsLimit}</button></div>` : ""}
    ${footer()}`;
}

const capitalize = (text) => text.charAt(0).toUpperCase() + text.slice(1);

function caseRow(c, titles, filter) {
  const keys = filter ? [filter] : c.situations;
  return `
    <div class="case-row row">
      <div class="case-top">
        <span class="case-date">${c.date.split("-").reverse().join(".")}</span>
        <span class="case-title">${esc(c.title)}</span>
        ${c.setka === false ? `<span class="badge warn-badge">не как у Setka</span>` : ""}
      </div>
      ${keys.map((key) => `
        <div class="case-line"><b>${esc(titles[key] ?? key)}.</b> ${esc(capitalize(c.details?.[key] ?? ""))}</div>`).join("")}
      <div class="case-actions">
        <a href="${esc(setkaLink(c.date, c.hall, c.period))}" target="_blank" rel="noopener">Setka Cup ↗</a>
        <a href="?date=${esc(c.date)}&t=${c.id}" data-action="open" data-date="${esc(c.date)}" data-id="${c.id}">Наш расчёт ›</a>
      </div>
    </div>`;
}

/** «2026-10-05 Мужчины Утро Африка» → категория «Мужчины», время дня «Утро», зал «Африка» */
function titleParts(t) {
  const [division = "", period = "", ...hall] = tournamentTitle(t).split(" ");
  return { division, period, hall: hall.join(" ") || "Другие" };
}

/** Порядок по времени суток: номера Setka идут не по часам (День2 — 5, Вечер — 2) */
const PERIODS = ["Утро", "День", "День1", "День2", "Вечер", "Ночь", "Ночь1", "Ночь2"];

function periodOrder(t) {
  const index = PERIODS.indexOf(titleParts(t).period);
  return index === -1 ? PERIODS.length : index;
}

/** Турниры дня по залам (Сеул и Токио, затем залы с идущим турниром, затем по алфавиту), внутри зала — по времени дня */
function halls(tournaments) {
  const groups = new Map();
  for (const t of tournaments) {
    const key = t.locationId;
    if (!groups.has(key)) groups.set(key, { name: titleParts(t).hall, tournaments: [] });
    groups.get(key).tournaments.push(t);
  }
  return [...groups.values()]
    .map((g) => ({
      ...g,
      tournaments: g.tournaments.sort((a, b) => periodOrder(a) - periodOrder(b) || a.dayPeriodToken - b.dayPeriodToken),
      live: g.tournaments.some((t) => !isFinished(t) && !isNotStarted(t)),
      // В зале и мужские, и женские турниры — подписываем категорию
      mixed: new Set(g.tournaments.map((t) => titleParts(t).division)).size > 1,
    }))
    .sort((a, b) => pinOrder(a.name) - pinOrder(b.name) || b.live - a.live || a.name.localeCompare(b.name, "ru"));
}

/** Залы, которые всегда сверху, в этом порядке; за ними — залы, где идёт турнир, потом остальные по алфавиту */
const PINNED_HALLS = ["Сеул", "Токио"];

function pinOrder(name) {
  const index = PINNED_HALLS.indexOf(name);
  return index === -1 ? PINNED_HALLS.length : index;
}

function tournamentRow(t, date, inHall = null) {
  const players = new Set(t.matches.flatMap((m) => [m.player1?.id, m.player2?.id]).filter((x) => x != null)).size;
  const played = t.matches.filter((m) => m.winnerId != null).length;
  const badge = isNotStarted(t)
    ? `<span class="badge soon">скоро</span>`
    : !isFinished(t) ? `<span class="badge live">идёт · ${played}/${t.matches.length}</span>` : "";
  return `
    <button class="tournament row" data-action="open" data-date="${esc(date)}" data-id="${t.id}">
      <span class="info">
        <span class="name">${esc(rowTitle(t, inHall))}</span><br>
        <span class="sub">${players} ${playersNoun(players)} · сыграно ${played} из ${t.matches.length}</span>
      </span>
      ${badge}
      <span class="chevron">›</span>
    </button>`;
}

/** Внутри зала — только время дня (и категория, если в зале их несколько); в общем списке — полное название */
function rowTitle(t, inHall) {
  if (inHall == null) return tournamentTitle(t);
  const { division, period } = titleParts(t);
  return inHall || division !== "Мужчины" ? `${period} · ${division}` : period;
}

// --- «Посчитать с исходами»: свои исходы для несыгранных матчей, расчёт не официальный ---

/** id турнира, открыт ли выбор, выбранные исходы (id матча → «1:3:1» — победил первый 3:1) и применены ли они */
const whatIf = { id: null, open: false, picks: new Map(), applied: false };

/** Кнопка «Коэффициенты» у таблицы: показывать соотношения партий и мячей. Запоминается в браузере, если он позволяет */
let showRatios = (() => {
  try { return localStorage.getItem("showRatios") === "1"; } catch { return false; }
})();

/** Выбранный игрок: подсветка его встреч в таблицах и списке матчей. Сбрасывается при переходе к другому турниру */
const picked = { tournament: null, player: null };

/** Матчи, для которых можно выбрать исход: пары известны, результата нет и это не «L : L» */
const pendingMatches = (t) =>
  t.matches.filter((m) => m.player1 && m.player2 && m.winnerId == null && !isDoubleLoss(m))
    .sort((a, b) => a.forPositionId - b.forPositionId || a.position - b.position);

function outcomesOf(t) {
  const outcomes = new Map();
  if (whatIf.id !== t.id || !whatIf.applied) return outcomes;
  for (const [id, value] of whatIf.picks) {
    if (value === "ll") {
      outcomes.set(id, { doubleLoss: true });
      continue;
    }
    // «1:w» / «2:w» — техническая победа первого / второго
    const [side, won, lost] = value.split(":");
    if (won === "w") {
      outcomes.set(id, side === "1" ? { s1: 3, s2: 0, walkover: true } : { s1: 0, s2: 3, walkover: true });
      continue;
    }
    outcomes.set(id, side === "1" ? { s1: Number(won), s2: Number(lost) } : { s1: Number(lost), s2: Number(won) });
  }
  return outcomes;
}

function tournamentView(t, date = null) {
  if (whatIf.id !== t.id) Object.assign(whatIf, { id: t.id, open: false, picks: new Map(), applied: false });
  if (picked.tournament !== t.id) Object.assign(picked, { tournament: t.id, player: null });
  const outcomes = outcomesOf(t);
  const s = standings(t, { outcomes });
  const closed = isFinished(t);
  const notStarted = isNotStarted(t);
  const unfinished = t.matches.some((m) => m.winnerId == null && !isDoubleLoss(m));
  const pending = pendingMatches(t);
  const placementResolved = s.placementMatches.every((m) => m.winnerId != null || outcomes.has(m.id));
  return `
    <div class="topbar">
      <div class="side"><button class="ghost" data-action="back">‹ Назад</button></div>
      <h2>${esc(tournamentTitle(t))}</h2>
      <div class="side end">${t.isTest ? "" : `<button class="ghost icon" data-action="refresh" aria-label="Обновить" title="Обновить">↻</button>`}</div>
    </div>
    ${date ? `<p class="tournament-date">${esc(longDate(date))}</p>` : ""}
    ${t.isTest ? `
      <div class="card pad test-banner" style="margin-top:8px">
        <h3>🧪 Тестовые данные</h3>
        <p>Это ваш турнир, а не турнир Setka. Посчитан тем же способом, что и настоящие.</p>
        <div class="actions"><button class="outline small" data-action="test-edit">Изменить данные</button></div>
      </div>` : ""}
    ${notStarted ? notStartedView(s) : `
      ${whatIf.applied ? scenarioBanner(t, outcomes) : `
        ${closed ? notHeldBlock(t, pending.length > 0) : ""}`}
      ${whatIf.open && (whatIf.applied || closed) ? picker(t, pending) : ""}
      ${s.hasPlacementMatches && (placementResolved || closed) ? `
        <div class="section-title">Итоговые места</div>
        <div class="card">
          ${[...s.rows].sort((a, b) => a.place - b.place).map((r) => `
            <div class="final-row row">${place(r.place)}<span>${esc(fullName(r.player))}</span></div>`).join("")}
        </div>
        ${notHeld(t, s)}` : ""}
      <div class="section-title with-action">
        <span>${whatIf.applied ? "Таблица с выбранными исходами"
          : s.isGroupComplete || closed ? (s.hasPlacementMatches ? "Группа" : "Таблица") : "Таблица лидеров сейчас"}</span>
        <button class="outline small toggle" data-action="toggle-ratios" aria-pressed="${showRatios}">Коэффициенты</button>
      </div>
      <div class="card">${table(s)}</div>
      <p class="note ratio-note">Под счётом — коэффициенты за весь турнир. Места при равных очках решают не они, а встречи между этими игроками — что именно решило, написано под игроком (↳) и подробнее в «Почему так».</p>
      <div class="section-title">Результаты встреч</div>
      <div class="card cross-wrap">${crossTable(s, closed, outcomes)}</div>
      <p class="note">Нажмите на игрока — его встречи подсветятся здесь и в списке матчей. Нажмите ещё раз, чтобы снять.</p>
      <p class="note">Победа — 2 очка, поражение — 1, техническое поражение — 0. При равенстве мячи сравниваются по соотношению (выиграно ÷ проиграно) — по правилам ITTF, как у Setka.</p>
      ${setkaNote(t, s, outcomes)}
      ${s.ties.length ? `
        <div class="section-title">Почему так</div>
        <div class="card pad">
          ${s.ties.map((tie) => `
            <div class="tie">
              <h3>${esc(tie.title)}</h3>
              <ul>${tie.lines.map((line) => `<li>${esc(line[0].toUpperCase() + line.slice(1))}</li>`).join("")}</ul>
            </div>`).join("")}
        </div>` : ""}
      ${whatIf.applied ? "" : similarCases(t, s)}`}
    ${s.hasPlacementMatches ? `
      <div class="section-title">Финал и матч за 3-е место</div>
      <div class="card">${s.placementMatches.map((m) => matchRow(m, closed, outcomes)).join("")}</div>` : ""}
    <div class="section-title">Матчи группы</div>
    <div class="card">${s.groupMatches.map((m) => matchRow(m, closed, outcomes)).join("")}</div>
    ${notStarted ? "" : `<div class="after-matches">
      ${!whatIf.applied && !closed && unfinished ? provisional(s, pending.length > 0) : ""}
      ${whatIf.open && !whatIf.applied && !closed ? picker(t, pending) : ""}
      ${overallNote(s)}</div>`}
    <div class="actions" style="justify-content:center;margin-top:18px">
      <button class="outline" data-action="share">Поделиться ссылкой</button>
    </div>
    ${footer()}`;
}

// --- «Похожие случаи»: справочник прошлых нестандартных турниров (precedents.json, обновляется раз в неделю) ---

let precedents = null;

// no-cache: браузер каждый раз сверяется с сайтом, справочник обновляется раз в неделю
fetch("precedents.json", { cache: "no-cache" })
  .then((response) => (response.ok ? response.json() : null))
  .then((data) => {
    precedents = data;
    if (data) render();
  })
  .catch(() => {});

/** «суббота, 11 октября 2026» — дата турнира под кнопкой «Назад» */
const longDate = (date) => {
  const text = new Date(`${date}T12:00:00`).toLocaleDateString("ru-RU", { weekday: "long", day: "numeric", month: "long", year: "numeric" }).replace(/\s*г\.$/, "");
  return text[0].toUpperCase() + text.slice(1);
};
const shortDate = (date) => `${date.slice(8, 10)}.${date.slice(5, 7)}`;

function casesNoun(n) {
  const mod10 = n % 10, mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return "раз";
  if (mod10 >= 2 && mod10 <= 4 && !(mod100 >= 12 && mod100 <= 14)) return "раза";
  return "раз";
}

function similarCases(t, s) {
  if (!precedents) return "";
  const keys = detectSituations(t, s, setkaDifference(t, s));
  if (!keys.length) return "";
  const items = SITUATIONS.filter((x) => keys.includes(x.key)).map((situation) => {
    const stats = precedents.situations[situation.key] ?? { total: 0, confirmed: 0, mismatched: 0, cases: [] };
    const others = stats.cases.filter((c) => c.id !== t.id).slice(0, 3);
    const checked = stats.confirmed + stats.mismatched;
    const period = `${shortDate(precedents.from)}–${shortDate(precedents.to)}`;
    let basis = stats.total
      ? `Встречалось ${stats.total} ${casesNoun(stats.total)} за ${period}; наш подсчёт совпал с итогом Setka в ${stats.confirmed} из ${checked}.`
      : `В турнирах за ${period} такого не встречалось — вывод не проверен на прошлых случаях.`;
    if (stats.total === 1) basis += " Вывод сделан по одному турниру.";
    if (stats.mismatched) basis += ` ⚠️ Есть расхождения с Setka: ${stats.mismatched}.`;
    return `
      <div class="case">
        <h3>${esc(situation.title)}</h3>
        <p>${esc(situation.conclusion)}</p>
        <p class="hint">${esc(basis)}</p>
        ${others.length ? `
          <div class="case-links">Так было в:
            ${others.map((c) => `<a href="?date=${esc(c.date)}&t=${c.id}" data-action="open" data-date="${esc(c.date)}" data-id="${c.id}">${esc(c.title)}, ${shortDate(c.date)}</a>`).join(" · ")}
          </div>` : stats.total ? `<div class="hint">Этот турнир — единственный известный такой случай.</div>` : ""}
      </div>`;
  });
  // Свёрнуто по умолчанию; раскрытие запоминаем, чтобы обновление страницы его не сбрасывало
  return `
    <details class="card pad precedents" ${precedentsOpen ? "open" : ""}>
      <summary>📚 Похожие случаи <span class="muted">(${items.length})</span></summary>
      ${items.join("")}
    </details>`;
}
let precedentsOpen = false;

/** Сноска, если официальные места Setka не совпали с расчётом по правилам ITTF (редкие исключения) */
function setkaNote(t, s, outcomes) {
  if (outcomes.size) return "";
  const diff = setkaDifference(t, s);
  if (!diff.length) return "";
  return `
    <p class="note footnote">* Официальные места Setka отличаются от нашего расчёта: у Setka
      ${diff.map((d) => `<b>${d.setkaPlace}. ${esc(d.player.lastName)}</b>`).join(" · ")}.${s.overall?.length
        ? " Причина — полное равенство во встречах между собой: мы ставим по коэффициенту за весь турнир, у Setka порядок здесь произвольный."
        : " Такое за год случилось всего в нескольких турнирах из 11 869."}</p>`;
}

/** Турнир закрыт, а финал или матч за 3-е место не доигран — места из таблицы группы */
function notHeld(t, s) {
  if (!isFinished(t)) return "";
  const lines = s.placementMatches.filter((m) => m.winnerId == null && !whatIf.picks.has(m.id)).map((m) => {
    if (m.forPositionId === 2) return "Финал не состоялся — 1-е и 2-е места по таблице группы.";
    if (m.forPositionId === 3) return "Матч за 3-е место не состоялся — 3-е и 4-е места по таблице группы.";
    return `Матч за ${m.forPositionId}-е место не состоялся — места по таблице группы.`;
  });
  return lines.map((line) => `<p class="note">ℹ️ ${esc(line)}</p>`).join("");
}

/** Матч начали, но не доиграли: партии не только 11:0 / 0:11 (так Setka пишет неявку) */
function interrupted(m) {
  if (!m.setScores.length || m.setScores.every((x) => (x.p1 === 11 && x.p2 === 0) || (x.p1 === 0 && x.p2 === 11))) return "";
  return ` — прерван при ${liveScore(m)}`;
}

/** Закрытый турнир: какие матчи не состоялись или не доиграны и как они засчитаны */
function notHeldBlock(t, canPick) {
  const lines = t.matches
    .filter((m) => m.forPositionId <= 1 && (m.technical || m.winnerId == null))
    .sort((a, b) => a.position - b.position)
    .map((m) => {
      const pairText = `${m.player1?.lastName ?? "—"} — ${m.player2?.lastName ?? "—"}`;
      if (isDoubleLoss(m)) return `${pairText}: техническое поражение обоим, по 0 очков${interrupted(m)}`;
      if (m.winnerId == null) return `${pairText}: не сыгран, в подсчёте не учитывается`;
      const winner = m.winnerId === m.player1?.id ? m.player1 : m.player2;
      return `${pairText}: техническая победа ${winner?.lastName ?? ""} (+2 очка, 3:0 по партиям)${interrupted(m)}`;
    });
  if (!lines.length) return "";
  return `
    <div class="card pad info" style="margin-top:8px">
      <h3>ℹ️ Не состоялись или не доиграны</h3>
      <p>Турнир закрыт. Так эти матчи засчитаны в таблице — как у Setka:</p>
      ${lines.map((line) => `<div class="pair">${esc(line)}</div>`).join("")}
      ${canPick ? whatIfButton() : ""}
    </div>`;
}

function whatIfButton() {
  return `
    <div class="block">
      <button class="outline small" data-action="whatif-open">Посчитать с исходами</button>
      <p class="hint">Выберите, как могли бы закончиться несыгранные матчи, — таблица пересчитается.</p>
    </div>`;
}

function picker(t, pending) {
  const players = new Map(pending.flatMap((m) => [m.player1, m.player2]).map((p) => [p.id, p]));
  return `
    <div class="card pad picker" style="margin-top:8px">
      <h3>Исходы несыгранных матчей</h3>
      <label class="pick-row">
        <span>Снялся с турнира<br><span class="hint">травма, неявка — во всех его матчах техническое поражение</span></span>
        <select id="withdrawn">
          <option value="">никто</option>
          ${[...players.values()].map((p) => `<option value="${p.id}">${esc(p.lastName)}</option>`).join("")}
        </select>
      </label>
      ${pending.map((m) => {
        const current = whatIf.picks.get(m.id) ?? "";
        const opt = (value, label) => `<option value="${value}" ${current === value ? "selected" : ""}>${esc(label)}</option>`;
        const [a, b] = [m.player1.lastName, m.player2.lastName];
        return `
          <label class="pick-row">
            <span>${esc(pair(m))}</span>
            <select data-match="${m.id}" data-p1="${m.player1.id}" data-p2="${m.player2.id}">
              ${opt("", "не сыгран — не учитывать")}
              ${opt("1:3:0", `${a} 3:0`)}${opt("1:3:1", `${a} 3:1`)}${opt("1:3:2", `${a} 3:2`)}
              ${opt("2:3:2", `${b} 3:2`)}${opt("2:3:1", `${b} 3:1`)}${opt("2:3:0", `${b} 3:0`)}
              ${opt("1:w", `${a} — тех. победа (${b} не явился / снялся)`)}
              ${opt("2:w", `${b} — тех. победа (${a} не явился / снялся)`)}
              ${opt("ll", "L : L — поражение обоим")}
            </select>
          </label>`;
      }).join("")}
      <p class="hint">Мячи этих матчей неизвестны и в расчёт не идут. Техническая победа — 3:0 по партиям, +2 очка победителю и 0 проигравшему; «L : L» — обоим поражение и 0 очков, как у Setka.</p>
      <div class="actions">
        <button class="outline" data-action="whatif-close">Отмена</button>
        <button data-action="whatif-apply">Пересчитать</button>
      </div>
    </div>`;
}

function scenarioBanner(t, outcomes) {
  const chosen = t.matches.filter((m) => outcomes.has(m.id)).map((m) => {
    const o = outcomes.get(m.id);
    if (o.doubleLoss) return `${pair(m)}: L : L — поражение обоим`;
    const winner = o.s1 > o.s2 ? m.player1.lastName : m.player2.lastName;
    if (o.walkover) return `${pair(m)}: техническая победа ${winner}`;
    return `${pair(m)}: ${winner} ${Math.max(o.s1, o.s2)}:${Math.min(o.s1, o.s2)}`;
  });
  return `
    <div class="card pad scenario" style="margin-top:8px">
      <h3>🧮 Расчёт с выбранными исходами</h3>
      <p>Не официальный результат — так было бы, если бы матчи закончились так:</p>
      ${chosen.map((line) => `<div class="pair">${esc(line)}</div>`).join("")}
      <div class="actions">
        <button class="outline" data-action="whatif-reset">Сбросить</button>
        <button class="outline" data-action="whatif-open">Изменить</button>
      </div>
    </div>`;
}

function provisional(s, canPick) {
  const all = [...s.groupMatches, ...s.placementMatches];
  const live = all.filter(isLive);
  const remaining = all.filter((m) => m.winnerId == null && !isLive(m));
  let summary = `Сыграно ${s.playedCount} из ${s.groupMatches.length} матчей группы — таблица по сыгранным, места ещё могут измениться.`;
  if (s.hasPlacementMatches && !s.placementDone) summary += " Итоговые места определят финал и матч за 3-е место.";
  return `
    <div class="card pad warn" style="margin-top:8px">
      <h3>⚠️ Результат не окончательный</h3>
      <p>${esc(summary)}</p>
      ${live.length ? `
        <div class="block">
          <div class="label live">Идёт сейчас</div>
          ${live.map((m) => `<div class="pair"><b>${esc(pair(m))}</b><div class="live-score">${esc(liveScore(m))}</div></div>`).join("")}
        </div>` : ""}
      ${remaining.length ? `
        <div class="block">
          <div class="label">Ещё не сыграны · ${remaining.length}</div>
          ${remaining.map((m) => `<div class="pair">${esc(pair(m))}</div>`).join("")}
        </div>` : ""}
      ${canPick ? whatIfButton() : ""}
    </div>`;
}

function pair(m) {
  if (!m.player1 || !m.player2) {
    if (m.forPositionId === 2) return "Финал — пары определятся после группы";
    if (m.forPositionId === 3) return "Матч за 3-е место — пары определятся после группы";
    return "Пара определится позже";
  }
  const prefix = m.forPositionId === 2 ? "Финал: " : m.forPositionId === 3 ? "За 3-е место: " : "";
  return `${prefix}${m.player1.lastName} — ${m.player2.lastName}`;
}

function notStartedView(s) {
  return `
    <div class="card pad" style="margin-top:8px">
      <b>🕒 Турнир ещё не начался</b>
      <p class="note" style="margin:4px 0 0">Таблица появится после первых матчей. Нажмите «Обновить», чтобы проверить.</p>
    </div>
    <div class="section-title">Участники · ${s.rows.length}</div>
    <div class="card">
      ${[...s.rows].sort((a, b) => a.player.lastName.localeCompare(b.player.lastName, "ru"))
        .map((r) => `<div class="final-row row">${esc(fullName(r.player))}</div>`).join("")}
    </div>`;
}

function place(n) {
  return `<span class="place ${n <= 3 ? `p${n}` : ""}">${n}</span>`;
}

/** Дробь «выиграно ÷ проиграно» под счётом; видна, когда включена кнопка «Коэффициенты» */
function ratio(won, lost) {
  const text = lost ? (won / lost).toFixed(3).replace(".", ",") : won ? "∞" : "—";
  return `<div class="ratio">${text}</div>`;
}

/** Над таблицей: круг, где между собой всё поровну и места распределил коэффициент партий за весь турнир */
function overallNote(s) {
  if (!s.overall?.length) return "";
  const row = (id) => s.rows.find((r) => r.player.id === id);
  return s.overall.map(({ ids, byLot }) => {
    const names = ids.map((id) => row(id)?.player.lastName ?? "");
    const list = names.length < 2 ? names[0] : `${names.slice(0, -1).join(", ")} и ${names.at(-1)}`;
    const places = ids.map((id) => `${row(id)?.groupPlace} — ${row(id)?.player.lastName}`).join(", ");
    return `
      <div class="card pad info overall-note">
        <h3>⚖️ Круг между ${esc(list)}</h3>
        <p>Во встречах между собой всё поровну. Места распределились по коэффициенту партий между всеми игроками (за весь турнир), при равенстве — мячей${byLot ? "; где совпало и это — жребий" : ""}: ${esc(places)}.</p>
      </div>`;
  }).join("");
}

/** Счёт и коэффициент внутри круга равных — цветом круга, под общими (видны с «Коэффициентами») */
function circleRatio(won, lost) {
  const text = lost ? (won / lost).toFixed(3).replace(".", ",") : won ? "∞" : "—";
  return `<div class="ratio circle">${won}:${lost}<br>${text}</div>`;
}

/** Подписи кругов под таблицей: кто в круге и откуда цветные цифры */
function circleLegend(s) {
  if (!s.circles?.length) return "";
  const row = (id) => s.rows.find((r) => r.player.id === id);
  const byPlace = (ids) => [...ids].sort((a, b) => row(a).groupPlace - row(b).groupPlace);
  const name = (id) => row(id)?.player.lastName ?? "";
  const inner = (ids) => [...new Set(ids.map((id) => s.circleOf.get(id).ids))].filter((c) => c.length > 1 && c.length < ids.length);
  return `
    <div class="circle-legend">
      ${s.circles.map((ids, i) => `
        <div class="c${i % 4}"><span class="dot"></span>Круг ${i + 1}: ${esc(byPlace(ids).map(name).join(", "))}${inner(ids).map((c) => ` → затем между собой ${esc(byPlace(c).map(name).join(", "))}`).join("")}</div>`).join("")}
      <div class="note">Цветные цифры под партиями и мячами — счёт и коэффициент только во встречах внутри круга (если круг сузился — внутри последнего).</div>
    </div>`;
}

function table(s) {
  const rows = [...s.rows].sort((a, b) => a.groupPlace - b.groupPlace);
  const circleIndex = new Map((s.circles ?? []).flatMap((ids, i) => ids.map((id) => [id, i])));
  const inCircle = (id, key) => {
    const c = s.circleOf?.get(id);
    if (!c || (c.record.setsWon + c.record.setsLost === 0)) return "";
    return key === "sets" ? circleRatio(c.record.setsWon, c.record.setsLost) : circleRatio(c.record.ballsWon, c.record.ballsLost);
  };
  const cls = (id) => (circleIndex.has(id) ? ` in-circle c${circleIndex.get(id) % 4}` : "");
  return `
    <table class="standings">
      <thead><tr><th></th><th class="player">Игрок</th><th>В–П</th><th>Партии</th><th>Мячи</th><th>Очки</th></tr></thead>
      <tbody>
        ${rows.map((r) => `
          <tr class="pickable${cls(r.player.id)}" data-action="pick-player" data-player="${r.player.id}" data-players="${r.player.id}">
            <td>${place(r.groupPlace)}</td>
            <td class="player"><div class="last">${esc(r.player.lastName)}</div><div class="first">${esc(r.player.firstName)}${r.byLot ? " · жребий" : ""}</div></td>
            <td>${r.record.wins}–${r.record.losses}</td>
            <td>${r.record.setsWon}:${r.record.setsLost}${ratio(r.record.setsWon, r.record.setsLost)}${inCircle(r.player.id, "sets")}</td>
            <td class="balls">${r.record.ballsWon}:${r.record.ballsLost}${ratio(r.record.ballsWon, r.record.ballsLost)}${inCircle(r.player.id, "balls")}</td>
            <td class="points">${r.record.points}</td>
          </tr>
          ${s.decided?.has(r.player.id) ? `
            <tr class="decided-row${cls(r.player.id)}" data-players="${r.player.id}">
              <td></td><td colspan="5">↳ ${esc(capitalize(s.decided.get(r.player.id)))}</td>
            </tr>` : ""}`).join("")}
      </tbody>
    </table>
    ${circleLegend(s)}`;
}

/**
 * Шахматка, как на Setka: строка — игрок (номер слева — его место), столбец — соперник, в клетке счёт по партиям глазами игрока строки.
 * В двухкруговых турнирах в клетке обе встречи через «/»
 */
function crossTable(s, closed, outcomes) {
  const rows = [...s.rows].sort((a, b) => a.groupPlace - b.groupPlace);
  const cells = new Map();
  const add = (a, b, cell) => cells.set(`${a}-${b}`, [...(cells.get(`${a}-${b}`) ?? []), cell]);
  for (const m of s.groupMatches) {
    if (!m.player1 || !m.player2) continue;
    const a = m.player1.id, b = m.player2.id;
    const pick = outcomes.get(m.id);
    const g = game(m);
    if (pick) {
      add(a, b, { side: "red", text: `${pick.s1}:${pick.s2}*`, cls: pick.s1 > pick.s2 ? "win" : "loss" });
      add(b, a, { side: "blue", text: `${pick.s2}:${pick.s1}*`, cls: pick.s2 > pick.s1 ? "win" : "loss" });
    } else if (g?.doubleLoss) {
      add(a, b, { side: "red", text: "L:L", cls: "loss" });
      add(b, a, { side: "blue", text: "L:L", cls: "loss" });
    } else if (g) {
      const mark = g.walkover ? " тех." : "";
      add(a, b, { side: "red", text: `${g.s1}:${g.s2}${mark}`, cls: g.winner === a ? "win" : "loss" });
      add(b, a, { side: "blue", text: `${g.s2}:${g.s1}${mark}`, cls: g.winner === b ? "win" : "loss" });
    } else {
      const live = !closed && isLive(m);
      const text = live ? "идёт" : closed ? "не сост." : "";
      add(a, b, { side: "red", text, cls: live ? "live" : "wait" });
      add(b, a, { side: "blue", text, cls: live ? "live" : "wait" });
    }
  }
  const cell = (row, col) => {
    if (row === col) return `<td class="self" data-players="${row} ${col}">●</td>`;
    const list = cells.get(`${row}-${col}`) ?? [];
    return `<td data-players="${row} ${col}">${list.map((c) => `<span class="side-dot ${c.side}"></span><span class="${c.cls}">${esc(c.text)}</span>`).join(" / ")}</td>`;
  };
  return `
    <table class="cross">
      <thead><tr><th class="name">Игрок</th>${rows.map((r, i) => `<th data-players="${r.player.id}">${i + 1}</th>`).join("")}<th>Очки</th></tr></thead>
      <tbody>
        ${rows.map((r, i) => `
          <tr>
            <th class="name pickable" data-action="pick-player" data-player="${r.player.id}" data-players="${r.player.id}"><span class="num">${i + 1}</span>${esc(r.player.lastName)}</th>
            ${rows.map((c) => cell(r.player.id, c.player.id)).join("")}
            <td class="points" data-players="${r.player.id}">${r.record.points}</td>
          </tr>`).join("")}
      </tbody>
    </table>`;
}

function applyPick() {
  // На других экранах подсвечивать нечего
  const id = app.querySelector("[data-players]") ? picked.player : null;
  app.classList.toggle("picking", id != null);
  for (const el of app.querySelectorAll("[data-players]")) {
    el.classList.toggle("hl", id != null && el.dataset.players.split(" ").includes(String(id)));
  }
}

function matchRow(m, closed, outcomes) {
  const g = game(m);
  const pick = outcomes.get(m.id);
  const live = !closed && !pick && isLive(m);
  const score = pick ? `${pick.s1}:${pick.s2}*`
    : g?.doubleLoss ? "тех. –:–"
    : live ? "идёт"
    : g ? `${g.s1}:${g.s2}${g.walkover ? " тех." : ""}`
    : closed ? "не сост." : "–:–";
  const winnerId = pick ? (pick.s1 > pick.s2 ? m.player1.id : m.player2.id) : m.winnerId;
  const cls = (p) => (g?.doubleLoss ? "" : winnerId == null ? "open" : p && p.id === winnerId ? "win" : "");
  return `
    <div class="match row" data-players="${m.player1?.id ?? ""} ${m.player2?.id ?? ""}">
      <div class="line">
        <span class="p pickable ${cls(m.player1)}" ${m.player1 ? `data-action="pick-player" data-player="${m.player1.id}"` : ""}>${esc(m.player1?.lastName ?? "—")}</span>
        <span class="score ${live ? "live" : g ? "" : "wait"}">${score}</span>
        <span class="p right pickable ${cls(m.player2)}" ${m.player2 ? `data-action="pick-player" data-player="${m.player2.id}"` : ""}>${esc(m.player2?.lastName ?? "—")}</span>
      </div>
      ${m.setScores.length ? `<div class="sets">${m.setScores.map((x) => `${x.p1}:${x.p2}`).join(" ")}</div>` : ""}
    </div>`;
}

function footer() {
  return `<p class="footer">Места по правилам ITTF, данные Setka Cup. Неофициальная страница.</p>`;
}

// --- Действия ---

function bind() {
  app.querySelectorAll("[data-action]").forEach((el) => el.addEventListener("click", onAction));
  app.querySelector("details.precedents")?.addEventListener("toggle", (e) => { precedentsOpen = e.target.open; });
  applyPick();
  app.classList.toggle("show-ratios", showRatios);
  const day = document.getElementById("day");
  day?.addEventListener("change", () => day.value && go({ date: day.value }));
  const link = document.getElementById("link");
  link?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      openLink(link.value);
    }
  });
  // «Снялся с турнира»: во всех его несыгранных матчах — техническая победа соперника
  const withdrawn = document.getElementById("withdrawn");
  withdrawn?.addEventListener("change", () => {
    for (const select of app.querySelectorAll("select[data-match]")) {
      if (select.dataset.p1 === withdrawn.value) select.value = "2:w";
      else if (select.dataset.p2 === withdrawn.value) select.value = "1:w";
    }
  });
  // Статистика: поиск по Enter или при уходе с поля
  const search = document.getElementById("stats-q");
  const runSearch = () => {
    statsLimit = 50;
    go({ stats: state().stats, q: search.value.trim() }, { replace: true });
    document.getElementById("stats-q")?.focus();
  };
  search?.addEventListener("change", runSearch);
  search?.addEventListener("keydown", (e) => e.key === "Enter" && (e.preventDefault(), runSearch()));
  // Тест: подсказка «партии не сходятся со счётом» обновляется сразу
  for (const field of app.querySelectorAll("[data-result], [data-sets]")) {
    field.addEventListener("change", () => {
      const key = field.dataset.result ?? field.dataset.sets;
      const result = app.querySelector(`[data-result="${key}"]`).value;
      const sets = app.querySelector(`[data-sets="${key}"]`).value;
      app.querySelector(`[data-mismatch="${key}"]`).hidden = !setsMismatch(result, sets);
    });
  }
}

async function onAction(event) {
  const el = event.currentTarget;
  if (el.tagName === "A") event.preventDefault();
  switch (el.dataset.action) {
    case "open":
      go({ date: el.dataset.date, t: el.dataset.id });
      break;
    case "back": {
      const s = state();
      if (depth > 0) history.back();
      else if (s.test === "view") go({ test: "edit", d: s.d });
      else go({ date: s.date });
      break;
    }
    case "download-csv": {
      if (!precedents) break;
      const url = URL.createObjectURL(new Blob([toCSV(precedents)], { type: "text/csv;charset=utf-8" }));
      const a = Object.assign(document.createElement("a"), { href: url, download: `setka-sluchai-${precedents.to}.csv` });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      break;
    }
    case "stats-open":
      statsLimit = 50;
      go({ stats: "all" });
      break;
    case "stats-filter":
      statsLimit = 50;
      go({ stats: el.dataset.key, q: state().q }, { replace: true });
      break;
    case "stats-more":
      statsLimit += 50;
      render();
      break;
    case "train-open":
      go({ train: "menu" });
      break;
    case "train-level":
      train.level = null;
      go({ train: el.dataset.level }, { replace: true });
      break;
    case "train-next":
      train.level = null;
      render();
      window.scrollTo({ top: 0 });
      break;
    case "train-pick": {
      const id = Number(el.dataset.player);
      const at = train.order.indexOf(id);
      if (at === -1) train.order.push(id);
      else train.order.splice(at, 1);
      render();
      break;
    }
    case "train-reset":
      train.order = [];
      render();
      break;
    case "train-ratios":
      train.ratios = !train.ratios;
      render();
      break;
    case "train-hint":
      train.hint = true;
      render();
      break;
    case "train-check": {
      train.checked = true;
      if (!train.counted) {
        const ok = train.order.every((id, i) => setkaPlaces(train.t, id).includes(i + 1));
        saveTrainScore(train.level, ok, train.hint);
        markTrainPlayed(train.level, train.t.id);
        train.counted = true;
      }
      render();
      break;
    }
    case "train-reveal":
      train.revealed = !train.revealed;
      render();
      break;
    case "pay-open":
      go({ pay: 1 });
      break;
    case "pay-prev":
    case "pay-next": {
      const p = payPeriod(state());
      const next = el.dataset.action === "pay-prev" ? periodFor(addDays(p.from, -1)) : periodFor(addDays(p.to, 1));
      go({ pay: 1, from: next.from, to: next.to }, { replace: true });
      break;
    }
    case "pay-custom": {
      const from = document.getElementById("pay-from").value;
      const to = document.getElementById("pay-to").value;
      if (!from || !to || from > to) break;
      const limit = addDays(from, PAY.maxDays - 1);
      go({ pay: 1, from, to: to > limit ? limit : to }, { replace: true });
      break;
    }
    case "help-open":
      go({ help: 1 });
      window.scrollTo({ top: 0 });
      break;
    case "test-open":
      go({ test: "edit" });
      break;
    case "test-edit":
      go({ test: "edit", d: state().d });
      break;
    case "test-add":
      readEditor();
      if (testDraft.players.length < MAX_PLAYERS) testDraft.players.push(`Игрок ${testDraft.players.length + 1}`);
      showEditor();
      break;
    case "test-remove":
      testDraft = removePlayer(readEditor(), Number(el.dataset.index));
      showEditor();
      break;
    case "test-random":
      readEditor();
      testDraft.results = randomResults(testDraft.players.length);
      showEditor();
      break;
    case "test-clear":
      readEditor();
      testDraft.results = {};
      showEditor();
      break;
    case "test-run":
      // Новые данные — прежние выбранные исходы «Посчитать с исходами» не подходят
      Object.assign(whatIf, { id: null, open: false, picks: new Map(), applied: false });
      go({ test: "view", d: encode(readEditor()) });
      window.scrollTo({ top: 0 });
      break;
    case "refresh": {
      const s = state();
      el.disabled = true;
      el.textContent = "…";
      try {
        await loadDay(s.date, { fresh: true });
      } catch { /* покажем то, что было */ }
      render();
      break;
    }
    case "paste":
      try {
        const text = await navigator.clipboard.readText();
        document.getElementById("link").value = text;
        openLink(text);
      } catch {
        showError("Не получилось прочитать буфер обмена — вставьте ссылку в поле вручную.");
      }
      break;
    case "whatif-open":
      whatIf.open = true;
      render();
      break;
    case "whatif-close":
      whatIf.open = false;
      render();
      break;
    case "whatif-apply":
      whatIf.picks = new Map([...app.querySelectorAll("select[data-match]")]
        .filter((select) => select.value)
        .map((select) => [Number(select.dataset.match), select.value]));
      whatIf.applied = whatIf.picks.size > 0;
      whatIf.open = false;
      render();
      window.scrollTo({ top: 0, behavior: "smooth" });
      break;
    case "whatif-reset":
      Object.assign(whatIf, { open: false, picks: new Map(), applied: false });
      render();
      break;
    case "toggle-ratios":
      showRatios = !showRatios;
      try { localStorage.setItem("showRatios", showRatios ? "1" : "0"); } catch { /* приватный режим */ }
      app.classList.toggle("show-ratios", showRatios);
      el.setAttribute("aria-pressed", String(showRatios));
      break;
    case "pick-player": {
      const id = Number(el.dataset.player);
      picked.player = picked.player === id ? null : id;
      applyPick();
      break;
    }
    case "open-link":
      openLink(document.getElementById("link").value);
      break;
    case "share": {
      const url = location.href;
      try {
        if (navigator.share) await navigator.share({ title: document.title, url });
        else {
          await navigator.clipboard.writeText(url);
          el.textContent = "Ссылка скопирована";
        }
      } catch { /* закрыли окно «Поделиться» */ }
      break;
    }
  }
}

function openLink(text) {
  const link = parseLink(text);
  if (!link) {
    showError("Не похоже на ссылку Setka Cup. Нужна ссылка с датой, например: setkacup.com/ru/schedule?date=2026-10-05&hall=7&period=3");
    return;
  }
  go({ date: link.date, hall: link.hall, period: link.period });
}

function showError(text) {
  let note = app.querySelector(".note.error");
  if (!note) {
    note = document.createElement("p");
    note.className = "note error";
    app.querySelector(".note")?.after(note);
  }
  note.textContent = text;
}

render();
