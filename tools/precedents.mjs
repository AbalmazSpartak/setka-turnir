// Справочник нестандартных случаев (precedents.json) для блока «Похожие случаи» на странице.
//   node tools/precedents.mjs --dir <папка с днями 2026-*.json>   — из скачанных файлов
//   node tools/precedents.mjs --fetch 14                         — скачать последние 14 дней у Setka
// Новые турниры дописываются к уже собранным; по каждому случаю отмечено, совпал ли наш подсчёт с итогом Setka.
// Раз в неделю запускается сам — .github/workflows/precedents.yml
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parseTournaments, standings, isFinished, tournamentTitle, matchesSetka, ittfDifference } from "../standings.js";
import { SITUATIONS, detectSituations } from "../situations.js";

const OUT = new URL("../precedents.json", import.meta.url).pathname;
const args = process.argv.slice(2);
const arg = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);

/** Дни турниров: [дата запроса, ответ Setka] */
async function loadDays() {
  const days = [];
  const dir = arg("--dir");
  if (dir) {
    for (const file of readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort()) {
      days.push([file.slice(0, 10), JSON.parse(readFileSync(join(dir, file), "utf8"))]);
    }
  }
  const fetchDays = Number(arg("--fetch") ?? 0);
  for (let i = fetchDays; i >= 1; i--) {
    const date = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    const response = await fetch(`https://tabletennis.setkacup.com/api/Tournaments/ru?date=${date}`);
    if (!response.ok) throw new Error(`Setka ответила ${response.status} на ${date}`);
    days.push([date, await response.json()]);
  }
  return days;
}

const previous = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : { tournaments: {}, days: [] };
const tournaments = previous.tournaments;
const scannedDays = new Set(previous.days);

for (const [date, json] of await loadDays()) {
  scannedDays.add(date);
  for (const t of parseTournaments(json)) {
    if (!isFinished(t)) continue;
    const s = standings(t);
    const situations = detectSituations(t, s, ittfDifference(t, s));
    // Обычные турниры не храним — только те, где есть что показать
    if (!situations.length) {
      delete tournaments[t.id];
      continue;
    }
    tournaments[t.id] = { date, title: tournamentTitle(t), situations, setka: matchesSetka(t, s) };
  }
}

// Сводка по видам: сколько случаев, сколько подтвердили итог Setka, сколько разошлись, у скольких итогов нет
const summary = {};
for (const situation of SITUATIONS) {
  const cases = Object.entries(tournaments)
    .filter(([, x]) => x.situations.includes(situation.key))
    .map(([id, x]) => ({ id: Number(id), date: x.date, title: x.title, setka: x.setka }))
    .sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id);
  summary[situation.key] = {
    total: cases.length,
    confirmed: cases.filter((c) => c.setka === true).length,
    mismatched: cases.filter((c) => c.setka === false).length,
    cases,
  };
}

const days = [...scannedDays].sort();
writeFileSync(OUT, JSON.stringify({
  updated: new Date().toISOString().slice(0, 10),
  from: days[0],
  to: days.at(-1),
  days,
  situations: summary,
  tournaments,
}, null, 1));

console.log(`дней ${days.length} (${days[0]} — ${days.at(-1)})`);
for (const [key, x] of Object.entries(summary)) {
  console.log(`${key}: ${x.total} случаев, совпало с Setka ${x.confirmed}, расхождений ${x.mismatched}`);
  for (const c of x.cases.filter((c) => c.setka === false)) console.log(`  РАСХОЖДЕНИЕ ${c.date} ${c.id} ${c.title}`);
}
