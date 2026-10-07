// Сверка подсчёта с официальными местами Setka на скачанных днях турниров:
// node tools/validate.mjs <папка с файлами 2026-*.json>
// Турниры, где у Setka итоги не обновились после последнего матча (пустые positions), ошибкой не считаются
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseTournaments, standings, isFinished } from "../standings.js";

const dir = process.argv[2];
let total = 0, ok = 0;
const mismatches = [];
for (const file of readdirSync(dir).filter((f) => f.startsWith("2026")).sort()) {
  const raw = JSON.parse(readFileSync(join(dir, file), "utf8"));
  const tournaments = parseTournaments(raw);
  tournaments.forEach((t, index) => {
    const result = raw[index].result;
    if (!isFinished(t) || !result?.players || Array.isArray(result.players)) return;
    const positions = result.positions && !Array.isArray(result.positions) ? result.positions : {};
    const s = standings(t);
    total++;
    const bad = s.rows.filter((row) => {
      const key = String(row.player.id);
      const p = result.players[key];
      return ![positions[key], p?.real_position, p?.position].includes(row.place);
    });
    if (bad.length === 0) ok++;
    else mismatches.push(`${t.id} ${t.token}: ${bad.map((r) => r.player.lastName).join(", ")}`);
  });
}
console.log(`total ${total} ok ${ok}`);
mismatches.forEach((m) => console.log(m));
