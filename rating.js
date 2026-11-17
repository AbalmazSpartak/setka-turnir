// Пересчёт рейтинга Setka, пока Setka его не обновляет (с 12.11.2026 рейтинг у неё застыл).
// Формула выведена по рейтингам Setka на каждый день 10.09–11.11.2026 (2705 мужчин): совпадает с Setka
// до десятой в 85% случаев, в пределах ±0,1 — в 98%. Опубликованной формулы у Setka нет — это наш вывод.
//
// Каждый матч: u — разница рейтингов «в сторону неожиданности» (победа: соперник − я, поражение: я − соперник),
// рейтинги — до турнира. Очки: 0,25, если u < −2 (выиграл явный фаворит); 0,5, если −2 ≤ u < 0;
// 0,425 + 0,08·u, если u ≥ 0 (выиграл слабейший или равный). Победителю +очки, проигравшему −столько же.
// Технические результаты не считаются; счёт по партиям и вес игрока — не важны.
// Турниры — по очереди, в порядке окончания: каждый от рейтингов после предыдущих

/** Очки за матч игроку с рейтингом me против opp: + за победу, − за поражение */
export function matchPoints(me, opp, win) {
  const u = win ? opp - me : me - opp;
  const points = u < -2 ? 0.25 : u < 0 ? 0.5 : 0.425 + 0.08 * u;
  return win ? points : -points;
}

/** Конец турнира: начало последнего матча по расписанию + 25 минут (Setka считает турнир в день его окончания, UTC) */
const endOf = (t) => {
  const last = t.matches.map((m) => m.start).filter(Boolean).sort().at(-1);
  return last ? new Date(Date.parse(last) + 25 * 60000).toISOString() : null;
};

/**
 * Рейтинги после турниров: base — { date, missed, ratings } (rating-base.json), tournaments — разобранные турниры
 * (standings.js) за дни с base.date. Берутся турниры, закончившиеся после base.date, и пропущенные Setka (missed).
 * Идущий турнир — по сыгранным матчам. Игрок без рейтинга в base не пересчитывается (и матчи с ним — тоже).
 * Возвращает Map id → рейтинг
 */
export function recalcRatings(base, tournaments) {
  const current = new Map(Object.entries(base.ratings).map(([id, r]) => [Number(id), r]));
  const missed = new Set(base.missed ?? []);
  const unique = new Map(tournaments.map((t) => [t.id, t]));
  const list = [...unique.values()]
    .map((t) => ({ t, end: endOf(t) }))
    .filter(({ t, end }) => end && (end.slice(0, 10) > base.date || missed.has(t.id)))
    .sort((a, b) => a.end.localeCompare(b.end));
  for (const { t } of list) {
    // Изменения копятся и применяются после турнира: все его матчи — от рейтингов до турнира
    const change = new Map();
    for (const m of t.matches) {
      if (m.winnerId == null || m.technical || !m.player1 || !m.player2) continue;
      const a = m.player1.id, b = m.player2.id;
      const ra = current.get(a), rb = current.get(b);
      if (ra == null || rb == null) continue;
      change.set(a, (change.get(a) ?? 0) + matchPoints(ra, rb, m.winnerId === a));
      change.set(b, (change.get(b) ?? 0) + matchPoints(rb, ra, m.winnerId === b));
    }
    for (const [id, v] of change) current.set(id, current.get(id) + v);
  }
  return current;
}
