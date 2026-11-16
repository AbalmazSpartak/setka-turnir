// Зарплата игрока за период: выход на турнир (ставка по времени дня) + каждая победа.
// Пока только для одного игрока; ставки — от него (10.2026)
import { game, isFinished, isNotStarted, tournamentTitle } from "./standings.js?v=46";

export const PAY = {
  playerId: 1997,
  playerName: "Абальмаз Спартак",
  currency: "грн",
  /** За выход на турнир — по времени дня из названия («Мужчины Ночь Сеул»); остальные времена не оплачиваются.
   *  Вечер — 1530, а не 1800: так сходятся все выплаты августа–сентября */
  entry: { "Вечер": 1530, "Ночь": 2000, "Ночь1": 2000, "Ночь2": 2000 },
  win: 120,
  /** Техническая победа — соперник не явился или снялся */
  walkoverWin: 60,
  /** Выплаты примерно в эти числа; каждая — за дни с прошлой выплаты по день перед ней */
  payoutDays: [1, 8, 15, 22, 29],
  /**
   * Пришедшие выплаты: день, сумма и по какой день турниров она закрыла (upTo), accrued — начислено за эти турниры.
   * Сверено с турнирами 12.10.2026 и 16.11.2026; новые выплаты дописываются сюда
   */
  payouts: [
    { date: "2026-08-04", amount: 2480.53, upTo: "2026-08-02", accrued: null },
    { date: "2026-08-07", amount: 6964.00, upTo: "2026-08-06", accrued: 6960 },
    { date: "2026-08-14", amount: 6376.95, upTo: "2026-08-13", accrued: 6370 },
    { date: "2026-08-21", amount: 7083.40, upTo: "2026-08-20", accrued: 7080 },
    { date: "2026-08-28", amount: 7083.40, upTo: "2026-08-27", accrued: 7080 },
    { date: "2026-09-01", amount: 6615.75, upTo: "2026-08-31", accrued: 6610 },
    { date: "2026-09-08", amount: 6964.00, upTo: "2026-09-07", accrued: 6960 },
    { date: "2026-09-15", amount: 6675.45, upTo: "2026-09-14", accrued: 6670 },
    { date: "2026-09-22", amount: 6844.60, upTo: "2026-09-21", accrued: 6840 },
    { date: "2026-09-29", amount: 9205.74, upTo: "2026-09-28", accrued: 9200 },
    { date: "2026-10-02", amount: 2241.73, upTo: "2026-09-30", accrued: 2240 },
    { date: "2026-10-12", amount: 9444.54, upTo: "2026-10-07", accrued: 9440 },
    { date: "2026-10-15", amount: 6784.90, upTo: "2026-10-14", accrued: 6780 },
    { date: "2026-10-23", amount: 4722.27, upTo: "2026-10-21", accrued: 4720 },
    { date: "2026-11-02", amount: 1774.08, upTo: "2026-10-31", accrued: 1770 },
    /** Два перевода (3208.87 + 4841.67); 1194 из них — за дорогу, сверх турниров (6840) */
    { date: "2026-11-10", amount: 8050.54, upTo: "2026-11-07", accrued: 6840 + 1194 },
    { date: "2026-11-16", amount: 8857.49, upTo: "2026-11-14", accrued: 8850 },
  ],
  /** Турниры, которые не оплачиваются и не считаются (id Setka): ночь Токио 20–21.10.2026 — по словам игрока */
  excluded: [63929],
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

/** Расчёт по турнирам дней для игрока (по умолчанию — свой): строки по турнирам и итог. excluded — только у своего */
export function payroll(days, playerId = PAY.playerId) {
  const rows = [];
  for (const { date, tournaments } of days) {
    for (const t of tournaments) {
      if (!t.matches.some((m) => m.player1?.id === playerId || m.player2?.id === playerId)) continue;
      if (isNotStarted(t) || (playerId === PAY.playerId && PAY.excluded.includes(t.id))) continue;
      let wins = 0, walkoverWins = 0, losses = 0;
      for (const m of t.matches) {
        const g = game(m);
        if (!g || g.doubleLoss || (g.p1 !== playerId && g.p2 !== playerId)) continue;
        if (g.winner !== playerId) losses++;
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

/** Имя игрока из матчей загруженных дней: «Фамилия Имя»; null — в эти дни не играл */
export function playerName(days, playerId) {
  for (const { tournaments } of days) {
    for (const t of tournaments) {
      for (const m of t.matches) {
        const p = [m.player1, m.player2].find((x) => x?.id === playerId);
        if (p) return `${p.lastName} ${p.firstName}`.trim();
      }
    }
  }
  return null;
}

/** Последняя записанная выплата и с какого дня турниры ещё не оплачены */
export function lastPayout() {
  const p = PAY.payouts.at(-1);
  return p ? { ...p, unpaidFrom: addDays(p.upTo, 1) } : null;
}
