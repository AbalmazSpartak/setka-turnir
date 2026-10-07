import { API_URL } from "./config.js?v=5";
import {
  parseTournaments, standings, parseLink, matchesLink, tournamentTitle, isFinished, isNotStarted,
  isLive, liveScore, game, fullName, playersNoun, ittfDifference,
} from "./standings.js?v=5";

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
  return { date: p.get("date"), hall: int("hall"), period: int("period"), id: int("t") };
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
    if (s.date && s.id != null) {
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

function loadingTournament() {
  return `
    <div class="topbar"><div class="side"><button class="ghost" data-action="back">‹ Назад</button></div><h2></h2><div class="side end"></div></div>
    <div class="center"><span class="spinner"></span></div>`;
}

function home(s, { tournaments, linkMatches, loading, message } = {}) {
  const date = s.date ?? today();
  return `
    <h1>Турнир</h1>
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
    ${halls(tournaments ?? []).map((hall) => `
      <div class="section-title hall">${esc(hall.name)}${hall.live ? ` <span class="badge live">идёт</span>` : ""}</div>
      <div class="card">
        ${hall.tournaments.map((t) => tournamentRow(t, date, hall.mixed)).join("")}
      </div>`).join("")}
    ${footer()}`;
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

function tournamentView(t) {
  const s = standings(t);
  const notStarted = isNotStarted(t);
  const unfinished = t.matches.some((m) => m.winnerId == null);
  return `
    <div class="topbar">
      <div class="side"><button class="ghost" data-action="back">‹ Назад</button></div>
      <h2>${esc(tournamentTitle(t))}</h2>
      <div class="side end"><button class="ghost icon" data-action="refresh" aria-label="Обновить" title="Обновить">↻</button></div>
    </div>
    ${notStarted ? notStartedView(s) : `
      ${unfinished ? provisional(s) : ""}
      ${s.hasPlacementMatches && (s.placementDone || isFinished(t)) ? `
        <div class="section-title">Итоговые места</div>
        <div class="card">
          ${[...s.rows].sort((a, b) => a.place - b.place).map((r) => `
            <div class="final-row row">${place(r.place)}<span>${esc(fullName(r.player))}</span></div>`).join("")}
        </div>
        ${notHeld(t, s)}` : ""}
      <div class="section-title">${s.isGroupComplete ? (s.hasPlacementMatches ? "Группа" : "Таблица") : "Таблица лидеров сейчас"}</div>
      <div class="card">${table(s)}</div>
      <p class="note">Победа — 2 очка, поражение — 1, техническое поражение — 0. При равенстве мячи сравниваются по разнице, как у Setka.</p>
      ${ittfNote(t, s)}
      ${s.ties.length ? `
        <div class="section-title">Почему так</div>
        <div class="card pad">
          ${s.ties.map((tie) => `
            <div class="tie">
              <h3>${esc(tie.title)}</h3>
              <ul>${tie.lines.map((line) => `<li>${esc(line[0].toUpperCase() + line.slice(1))}</li>`).join("")}</ul>
            </div>`).join("")}
        </div>` : ""}`}
    ${s.hasPlacementMatches ? `
      <div class="section-title">Финал и матч за 3-е место</div>
      <div class="card">${s.placementMatches.map(matchRow).join("")}</div>` : ""}
    <div class="section-title">Матчи группы</div>
    <div class="card">${s.groupMatches.map(matchRow).join("")}</div>
    <div class="actions" style="justify-content:center;margin-top:18px">
      <button class="outline" data-action="share">Поделиться ссылкой</button>
    </div>
    ${footer()}`;
}

/** Сноска, если по правилам ITTF (мячи по соотношению) места были бы другими */
function ittfNote(t, s) {
  const diff = ittfDifference(t, s);
  if (!diff.length) return "";
  return `
    <p class="note footnote">* По правилам ITTF (мячи сравниваются по соотношению, а не по разнице) результат был бы:
      ${diff.map((d) => `<b>${d.ittfPlace}. ${esc(d.player.lastName)}</b>`).join(" · ")}</p>`;
}

/** Турнир закрыт, а финал или матч за 3-е место не доигран — места из таблицы группы */
function notHeld(t, s) {
  if (!isFinished(t)) return "";
  const lines = s.placementMatches.filter((m) => m.winnerId == null).map((m) => {
    if (m.forPositionId === 2) return "Финал не состоялся — 1-е и 2-е места по таблице группы.";
    if (m.forPositionId === 3) return "Матч за 3-е место не состоялся — 3-е и 4-е места по таблице группы.";
    return `Матч за ${m.forPositionId}-е место не состоялся — места по таблице группы.`;
  });
  return lines.map((line) => `<p class="note">ℹ️ ${esc(line)}</p>`).join("");
}

function provisional(s) {
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

function matchRow(m) {
  const g = game(m);
  const live = isLive(m);
  const score = live ? "идёт" : g ? `${g.s1}:${g.s2}${g.walkover ? " тех." : ""}` : "–:–";
  const cls = (p) => (m.winnerId == null ? "open" : p && p.id === m.winnerId ? "win" : "");
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
}

async function onAction(event) {
  const el = event.currentTarget;
  switch (el.dataset.action) {
    case "open":
      go({ date: el.dataset.date, t: el.dataset.id });
      break;
    case "back":
      if (depth > 0) history.back();
      else go({ date: state().date });
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
