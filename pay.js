// Зарплата игрока за период: выход на турнир (ставка по времени дня) + каждая победа.
// Пока только для одного игрока; ставки — от него (10.2026)
import { game, isFinished, isNotStarted, tournamentTitle } from "./standings.js?v=22";

export const PAY = {
  playerId: 1997,
  playerName: "Абальмаз Спартак",
  currency: "грн",
  /** За выход на турнир — по времени дня из названия («Мужчины Ночь Сеул»); остальные времена не оплачиваются */
  entry: { "Вечер": 1800, "Ночь": 2000, "Ночь1": 2000, "Ночь2": 2000 },
  win: 120,
  /** Техническая победа — соперник не явился или снялся */
  walkoverWin: 60,
  /** Выплаты примерно в эти числа; каждая — за дни с прошлой выплаты по день перед ней */
  payoutDays: [1, 8, 15, 22, 29],
  /** Свои даты — не длиннее, чтобы не грузить у Setka слишком много дней */
  maxDays: 62,
};

const pad = (n) => String(n).padStart(2, "0");
export const isoDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parse = (iso) => new Date(`${iso}T12:00:00`);
export const addDays = (iso, n) => {
  const d = parse(iso);
  d.setDate(d.getDate() + n);
  return isoDate(d);
};

/** Дни выплат вокруг даты: с месяца раньше по месяц позже, по порядку (29-го нет в коротком феврале) */
function payoutDates(iso) {
  const base = parse(iso);
  const dates = [];
  for (let shift = -2; shift <= 1; shift++) {
    const y = base.getFullYear();
    const m = base.getMonth() + shift;
    const last = new Date(y, m + 1, 0).getDate();
    for (const day of PAY.payoutDays) if (day <= last) dates.push(isoDate(new Date(y, m, day, 12)));
  }
  return dates.sort();
}

/** Выплата, в которую попадает день: { payout, from, to } — from…to включительно, payout — день выплаты */
export function periodFor(iso) {
  const dates = payoutDates(iso);
  const index = dates.findIndex((d) => d > iso);
  return { payout: dates[index], from: dates[index - 1], to: addDays(dates[index], -1) };
}

/** Последняя уже наступившая выплата (сегодня — день выплаты или позже) */
export const lastPayoutPeriod = (todayIso) => periodFor(addDays(periodFor(todayIso).from, -1));

/** Дни периода по порядку */
export function daysBetween(from, to) {
  const days = [];
  for (let d = from; d <= to && days.length <= PAY.maxDays; d = addDays(d, 1)) days.push(d);
  return days;
}

const periodOf = (t) => tournamentTitle(t).split(" ")[1] ?? "";

/** Расчёт по турнирам дней: строки по турнирам и итог */
export function payroll(days) {
  const rows = [];
  for (const { date, tournaments } of days) {
    for (const t of tournaments) {
      if (!t.matches.some((m) => m.player1?.id === PAY.playerId || m.player2?.id === PAY.playerId)) continue;
      if (isNotStarted(t)) continue;
      let wins = 0, walkoverWins = 0, losses = 0;
      for (const m of t.matches) {
        const g = game(m);
        if (!g || g.doubleLoss || (g.p1 !== PAY.playerId && g.p2 !== PAY.playerId)) continue;
        if (g.winner !== PAY.playerId) losses++;
        else if (g.walkover) walkoverWins++;
        else wins++;
      }
      const period = periodOf(t);
      const entry = PAY.entry[period] ?? 0;
      rows.push({
        date, t, period, entry, wins, walkoverWins, losses,
        live: !isFinished(t),
        unpaidPeriod: !(period in PAY.entry),
        total: entry + wins * PAY.win + walkoverWins * PAY.walkoverWin,
      });
    }
  }
  const sum = (key) => rows.reduce((a, r) => a + r[key], 0);
  const byPeriod = new Map();
  for (const r of rows) byPeriod.set(r.period, (byPeriod.get(r.period) ?? 0) + 1);
  return {
    rows,
    byPeriod,
    wins: sum("wins"),
    walkoverWins: sum("walkoverWins"),
    losses: sum("losses"),
    total: sum("total"),
  };
}
