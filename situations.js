// Нестандартные ситуации в турнире и выводы, сделанные по прошлым турнирам Setka.
// Одни и те же признаки использует страница («Похожие случаи») и tools/precedents.mjs (справочник случаев)
// Файл без импортов: страница подключает его с номером версии, а данные о турнире передаёт сама

const isFinished = (t) => t.statusCode === "finished";
const isDoubleLoss = (m) => m.winnerId == null && m.score1 === "L" && m.score2 === "L";

/** Матч начат, но засчитан технически: партии не только 11:0 / 0:11 (так Setka пишет неявку) */
const interruptedTechnical = (m) =>
  m.technical && m.setScores.length > 0 && !m.setScores.every((x) => (x.p1 === 11 && x.p2 === 0) || (x.p1 === 0 && x.p2 === 11));

/** Технические поражения в группе по игрокам (без «L : L») */
function technicalLosses(t) {
  const losses = new Map();
  for (const m of t.matches) {
    if (m.forPositionId > 1 || !m.technical || m.winnerId == null || !m.player1 || !m.player2) continue;
    const loser = m.winnerId === m.player1.id ? m.player2 : m.player1;
    losses.set(loser.id, (losses.get(loser.id) ?? 0) + 1);
  }
  return losses;
}

/**
 * Виды ситуаций: признак (detect) и вывод о том, как Setka их считает.
 * Порядок — от самых редких и важных к частым
 */
export const SITUATIONS = [
  {
    key: "finalNotHeld",
    title: "Финал или матч за 3-е место не состоялся",
    conclusion: "Setka оставляет места по таблице группы: 1-е и 2-е (или 3-е и 4-е) — как в группе.",
    detect: (t) => isFinished(t) && t.matches.some((m) => m.forPositionId > 1 && m.winnerId == null),
  },
  {
    key: "doubleLoss",
    title: "Матч не состоялся по вине обоих («L : L»)",
    conclusion: "Setka засчитывает техническое поражение обоим: по 0 очков и поражение в «В–П». Места от этого не меняются.",
    detect: (t) => t.matches.some((m) => m.forPositionId <= 1 && isDoubleLoss(m)),
  },
  {
    key: "ballsRule",
    title: "Мячи: правила Setka и ITTF дают разный порядок",
    conclusion: "Setka сравнивает мячи по разнице (выиграно − проиграно), а ITTF — по соотношению (выиграно ÷ проиграно). Места ставятся по правилу Setka.",
    detect: (t, s, ittfDiff) => ittfDiff.length > 0,
  },
  {
    key: "interrupted",
    title: "Матч прерван — засчитана техническая победа",
    conclusion: "Setka засчитывает техническую победу (2 очка, 3:0 по партиям), а мячи сыгранных партий тоже идут в зачёт.",
    detect: (t) => t.matches.some((m) => m.forPositionId <= 1 && interruptedTechnical(m)),
  },
  {
    key: "withdrawal",
    title: "Игрок снялся с турнира",
    conclusion: "Все оставшиеся матчи снявшегося — технические поражения (0 очков, соперникам по 2 очка и 3:0). Уже сыгранные им матчи не отменяются.",
    detect: (t) => [...technicalLosses(t).values()].some((n) => n >= 2),
  },
  {
    key: "walkover",
    title: "Неявка на матч — техническая победа",
    conclusion: "Неявившемуся — 0 очков, сопернику — 2 очка и 3:0 по партиям (11:0 в каждой).",
    detect: (t) => [...technicalLosses(t).values()].some((n) => n === 1),
  },
  {
    key: "lot",
    title: "Полное равенство — места решил жребий",
    conclusion: "Равны очки, партии и мячи во встречах между собой. Порядок определяет жребий Setka — наш подсчёт берёт его из итогов Setka.",
    detect: (t, s) => s.rows.some((r) => r.byLot),
  },
];

/** Какие ситуации есть в турнире: ключи из SITUATIONS. ittfDiff — ittfDifference(t, s) из standings.js */
export function detectSituations(t, s, ittfDiff) {
  return SITUATIONS.filter((x) => x.detect(t, s, ittfDiff)).map((x) => x.key);
}
