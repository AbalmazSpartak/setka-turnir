import { API_URL } from "./config.js?v=13";
import {
  parseTournaments, standings, parseLink, matchesLink, tournamentTitle, isFinished, isNotStarted,
  isLive, liveScore, game, fullName, playersNoun, setkaDifference, isDoubleLoss,
} from "./standings.js?v=13";
import { SITUATIONS, detectSituations, setkaLink } from "./situations.js?v=13";
import { toCSV } from "./precedents-csv.js?v=13";
import {
  RESULTS, MIN_PLAYERS, MAX_PLAYERS, pairs, pairKey, emptyTest, buildTournament, randomResults, setsMismatch, encode, decode,
} from "./testmode.js?v=13";

const app = document.getElementById("app");

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
  return { date: p.get("date"), hall: int("hall"), period: int("period"), id: int("t"), test: p.get("test"), d: p.get("d"), stats: p.get("stats"), q: p.get("q") ?? "" };
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
    if (s.stats != null) {
      app.innerHTML = statsView(s);
      document.title = "Статистика случаев — Турнир";
    } else if (s.test) {
      renderTest(s);
    } else if (s.date && s.id != null) {
      app.innerHTML = loadingTournament();
      const t = (await loadDay(s.date)).find((x) => x.id === s.id);
      if (token !== renderToken) return;
      app.innerHTML = t ? tournamentView(t) : home(s, { message: "Такого турнира в этот день нет." });
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
    <p class="note footnote">Этот раздел создан не для того, чтобы подтвердить ваши результаты, а для того, чтобы возможными манипуляциями сломать логику приложения и выявить погрешности.</p>
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
      <button class="outline small" data-action="stats-open" title="Нестандартные случаи за год">📊</button>
      <button class="outline small" data-action="test-open" title="Тестовый раздел: попробовать сломать логику подсчёта">🧪 Тест</button>
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

/** Турниры дня по залам (по алфавиту), внутри зала — по времени дня */
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
    .sort((a, b) => pinOrder(a.name) - pinOrder(b.name) || a.name.localeCompare(b.name, "ru"));
}

/** Залы, которые всегда сверху, в этом порядке; остальные — по алфавиту */
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

/** Матчи, для которых можно выбрать исход: пары известны, результата нет и это не «L : L» */
const pendingMatches = (t) =>
  t.matches.filter((m) => m.player1 && m.player2 && m.winnerId == null && !isDoubleLoss(m))
    .sort((a, b) => a.forPositionId - b.forPositionId || a.position - b.position);

function outcomesOf(t) {
  const outcomes = new Map();
  if (whatIf.id !== t.id || !whatIf.applied) return outcomes;
  for (const [id, value] of whatIf.picks) {
    const [side, won, lost] = value.split(":").map(Number);
    outcomes.set(id, side === 1 ? { s1: won, s2: lost } : { s1: lost, s2: won });
  }
  return outcomes;
}

function tournamentView(t) {
  if (whatIf.id !== t.id) Object.assign(whatIf, { id: t.id, open: false, picks: new Map(), applied: false });
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
    ${t.isTest ? `
      <div class="card pad test-banner" style="margin-top:8px">
        <h3>🧪 Тестовые данные</h3>
        <p>Это ваш турнир, а не турнир Setka. Посчитан тем же способом, что и настоящие.</p>
        <div class="actions"><button class="outline small" data-action="test-edit">Изменить данные</button></div>
      </div>` : ""}
    ${notStarted ? notStartedView(s) : `
      ${whatIf.applied ? scenarioBanner(t, outcomes) : `
        ${!closed && unfinished ? provisional(s, pending.length > 0) : ""}
        ${closed ? notHeldBlock(t, pending.length > 0) : ""}`}
      ${whatIf.open ? picker(t, pending) : ""}
      ${s.hasPlacementMatches && (placementResolved || closed) ? `
        <div class="section-title">Итоговые места</div>
        <div class="card">
          ${[...s.rows].sort((a, b) => a.place - b.place).map((r) => `
            <div class="final-row row">${place(r.place)}<span>${esc(fullName(r.player))}</span></div>`).join("")}
        </div>
        ${notHeld(t, s)}` : ""}
      <div class="section-title">${whatIf.applied ? "Таблица с выбранными исходами"
        : s.isGroupComplete || closed ? (s.hasPlacementMatches ? "Группа" : "Таблица") : "Таблица лидеров сейчас"}</div>
      <div class="card">${table(s)}</div>
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
  return `
    <div class="section-title">📚 Похожие случаи</div>
    <div class="card pad">${items.join("")}</div>`;
}

/** Сноска, если официальные места Setka не совпали с расчётом по правилам ITTF (редкие исключения) */
function setkaNote(t, s, outcomes) {
  if (outcomes.size) return "";
  const diff = setkaDifference(t, s);
  if (!diff.length) return "";
  return `
    <p class="note footnote">* Официальные места Setka отличаются от расчёта по правилам ITTF: у Setka
      ${diff.map((d) => `<b>${d.setkaPlace}. ${esc(d.player.lastName)}</b>`).join(" · ")}. Такое за год случилось всего в 4 турнирах из 11 863.</p>`;
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
  return `
    <div class="card pad picker" style="margin-top:8px">
      <h3>Исходы несыгранных матчей</h3>
      ${pending.map((m) => {
        const current = whatIf.picks.get(m.id) ?? "";
        const opt = (value, label) => `<option value="${value}" ${current === value ? "selected" : ""}>${esc(label)}</option>`;
        const [a, b] = [m.player1.lastName, m.player2.lastName];
        return `
          <label class="pick-row">
            <span>${esc(pair(m))}</span>
            <select data-match="${m.id}">
              ${opt("", "не учитывать")}
              ${opt("1:3:0", `${a} 3:0`)}${opt("1:3:1", `${a} 3:1`)}${opt("1:3:2", `${a} 3:2`)}
              ${opt("2:3:2", `${b} 3:2`)}${opt("2:3:1", `${b} 3:1`)}${opt("2:3:0", `${b} 3:0`)}
            </select>
          </label>`;
      }).join("")}
      <p class="hint">Мячи этих матчей неизвестны и в расчёт не идут.</p>
      <div class="actions">
        <button class="outline" data-action="whatif-close">Отмена</button>
        <button data-action="whatif-apply">Пересчитать</button>
      </div>
    </div>`;
}

function scenarioBanner(t, outcomes) {
  const chosen = t.matches.filter((m) => outcomes.has(m.id)).map((m) => {
    const o = outcomes.get(m.id);
    const winner = o.s1 > o.s2 ? m.player1.lastName : m.player2.lastName;
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

function table(s) {
  const rows = [...s.rows].sort((a, b) => a.groupPlace - b.groupPlace);
  return `
    <table class="standings">
      <thead><tr><th></th><th class="player">Игрок</th><th>В–П</th><th>Партии</th><th>Мячи</th><th>Очки</th></tr></thead>
      <tbody>
        ${rows.map((r) => `
          <tr>
            <td>${place(r.groupPlace)}</td>
            <td class="player"><div class="last">${esc(r.player.lastName)}</div><div class="first">${esc(r.player.firstName)}${r.byLot ? " · жребий" : ""}</div></td>
            <td>${r.record.wins}–${r.record.losses}</td>
            <td>${r.record.setsWon}:${r.record.setsLost}</td>
            <td class="balls">${r.record.ballsWon}:${r.record.ballsLost}</td>
            <td class="points">${r.record.points}</td>
          </tr>`).join("")}
      </tbody>
    </table>`;
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
    <div class="match row">
      <div class="line">
        <span class="p ${cls(m.player1)}">${esc(m.player1?.lastName ?? "—")}</span>
        <span class="score ${live ? "live" : g ? "" : "wait"}">${score}</span>
        <span class="p right ${cls(m.player2)}">${esc(m.player2?.lastName ?? "—")}</span>
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
  const day = document.getElementById("day");
  day?.addEventListener("change", () => day.value && go({ date: day.value }));
  const link = document.getElementById("link");
  link?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      openLink(link.value);
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
