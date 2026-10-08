// Нестандартные ситуации в турнире и выводы, сделанные по прошлым турнирам Setka.
// Одни и те же признаки использует страница («Похожие случаи») и tools/precedents.mjs (база случаев и CSV).
// Файл без импортов: страница подключает его с номером версии, а данные о турнире передаёт сама:
// t — турнир, s — standings(t), setkaDiff — setkaDifference(t, s)

const isFinished = (t) => t.statusCode === "finished";
const isDoubleLoss = (m) => m.winnerId == null && m.score1 === "L" && m.score2 === "L";
const name = (p) => p?.lastName ?? "—";
const pairText = (m) => `${name(m.player1)} — ${name(m.player2)}`;
const setsText = (m) => m.setScores.map((x) => `${x.p1}:${x.p2}`).join(" ");
const winnerOf = (m) => (m.winnerId === m.player1?.id ? m.player1 : m.player2);

/** Матч начат, но засчитан технически: партии не только 11:0 / 0:11 (так Setka пишет неявку) */
const interruptedTechnical = (m) =>
  m.technical && m.setScores.length > 0 && !m.setScores.every((x) => (x.p1 === 11 && x.p2 === 0) || (x.p1 === 0 && x.p2 === 11));

/** Технические поражения в группе: id игрока → матчи */
function technicalLosses(t) {
  const losses = new Map();
  for (const m of t.matches) {
    if (m.forPositionId > 1 || !m.technical || m.winnerId == null || !m.player1 || !m.player2) continue;
    const loser = m.winnerId === m.player1.id ? m.player2 : m.player1;
    losses.set(loser.id, [...(losses.get(loser.id) ?? []), m]);
  }
  return losses;
}

const playerById = (t, id) => t.matches.flatMap((m) => [m.player1, m.player2]).find((p) => p?.id === id);

/**
 * Виды ситуаций: признак (detect), описание того, что произошло в турнире (details),
 * и вывод о том, как Setka их считает. Порядок — от самых редких и важных к частым
 */
export const SITUATIONS = [
  {
    key: "setkaDiffers",
    title: "Setka поставила места не по правилам ITTF",
    conclusion: "Почти всегда Setka считает строго по ITTF: за год совпало 11859 турниров из 11863. Здесь — одно из редких исключений; наш расчёт показывает места по правилам, а сноска под таблицей — как у Setka.",
    detect: (t, s, setkaDiff) => setkaDiff.length > 0,
    details: (t, s, setkaDiff) =>
      `у Setka: ${setkaDiff.map((d) => `${d.setkaPlace}. ${d.player.lastName}`).join(", ")}; по ITTF: ${
        [...setkaDiff].sort((a, b) => a.place - b.place).map((d) => `${d.place}. ${d.player.lastName}`).join(", ")}`,
  },
  {
    key: "finalNotHeld",
    title: "Финал или матч за 3-е место не состоялся",
    conclusion: "Setka оставляет места по таблице группы: 1-е и 2-е (или 3-е и 4-е) — как в группе.",
    detect: (t) => isFinished(t) && t.matches.some((m) => m.forPositionId > 1 && m.winnerId == null),
    details: (t) => t.matches.filter((m) => m.forPositionId > 1 && m.winnerId == null)
      .map((m) => `${m.forPositionId === 2 ? "финал" : "матч за 3-е место"} ${pairText(m)} не состоялся${m.setScores.length ? ` (прерван: ${setsText(m)})` : ""}`).join("; "),
  },
  {
    key: "doubleLoss",
    title: "Матч не состоялся по вине обоих («L : L»)",
    conclusion: "Setka засчитывает техническое поражение обоим: по 0 очков и поражение в «В–П». Места от этого не меняются.",
    detect: (t) => t.matches.some((m) => m.forPositionId <= 1 && isDoubleLoss(m)),
    details: (t) => t.matches.filter((m) => m.forPositionId <= 1 && isDoubleLoss(m)).map((m) => `${pairText(m)}: L : L`).join("; "),
  },
  {
    key: "noMeeting",
    title: "Равные очки, а встречи между ними не было",
    conclusion: "Сравнить встречи между собой нельзя — их нет. Правила ITTF тут предлагают жребий, но Setka, судя по прошлым турнирам, ставит выше того, у кого лучше соотношение партий за весь турнир (при равенстве — мячей). Это наш вывод по прошлым случаям, а не опубликованное правило Setka.",
    detect: (t, s) => isFinished(t) && (s.noMeeting ?? []).length > 0,
    details: (t, s) => s.noMeeting.map(({ ids, doubleLoss, decided }) => {
      const names = ids.map((id) => name(playerById(t, id)));
      const why = doubleLoss ? "матч L : L" : "матч не сыгран";
      return decided ? `${names.join(" выше ")} по общему счёту (${why})` : `${names.join(" и ")}: ${why}, общий счёт равный — жребий`;
    }).join("; "),
  },
  {
    key: "interrupted",
    title: "Матч прерван — засчитана техническая победа",
    conclusion: "Setka засчитывает техническую победу (2 очка, 3:0 по партиям), а мячи сыгранных партий тоже идут в зачёт.",
    detect: (t) => t.matches.some((m) => m.forPositionId <= 1 && interruptedTechnical(m)),
    details: (t) => t.matches.filter((m) => m.forPositionId <= 1 && interruptedTechnical(m))
      .map((m) => `${pairText(m)} прерван (${setsText(m)}): тех. победа ${name(winnerOf(m))}`).join("; "),
  },
  {
    key: "withdrawal",
    title: "Игрок снялся с турнира",
    conclusion: "Все оставшиеся матчи снявшегося — технические поражения (0 очков, соперникам по 2 очка и 3:0). Уже сыгранные им матчи не отменяются.",
    detect: (t) => [...technicalLosses(t).values()].some((list) => list.length >= 2),
    details: (t) => [...technicalLosses(t)].filter(([, list]) => list.length >= 2)
      .map(([id, list]) => `${name(playerById(t, id))} снялся: тех. поражений ${list.length}`).join("; "),
  },
  {
    key: "walkover",
    title: "Неявка на матч — техническая победа",
    conclusion: "Неявившемуся — 0 очков, сопернику — 2 очка и 3:0 по партиям (11:0 в каждой).",
    detect: (t) => [...technicalLosses(t).values()].some((list) => list.length === 1),
    details: (t) => [...technicalLosses(t).values()].filter((list) => list.length === 1)
      .map(([m]) => `${pairText(m)}: тех. победа ${name(winnerOf(m))}`).join("; "),
  },
  {
    key: "lot",
    title: "Полное равенство — места решил жребий",
    conclusion: "Равны очки, партии и мячи во встречах между собой. Порядок определяет жребий Setka — наш подсчёт берёт его из итогов Setka.",
    detect: (t, s) => s.rows.some((r) => r.byLot),
    details: (t, s) => `жребий между: ${s.rows.filter((r) => r.byLot).sort((a, b) => a.place - b.place).map((r) => r.player.lastName).join(", ")}`,
  },
];

/** Какие ситуации есть в турнире: ключи из SITUATIONS */
export function detectSituations(t, s, setkaDiff) {
  return SITUATIONS.filter((x) => x.detect(t, s, setkaDiff)).map((x) => x.key);
}

/** Описание каждой найденной ситуации: ключ → текст «что произошло» */
export function describeSituations(t, s, setkaDiff) {
  return Object.fromEntries(SITUATIONS.filter((x) => x.detect(t, s, setkaDiff)).map((x) => [x.key, x.details(t, s, setkaDiff)]));
}

/** Ссылка на турнир на сайте Setka Cup: день, зал и время дня */
export const setkaLink = (date, hall, period) =>
  `https://tabletennis.setkacup.com/ru/schedule?date=${date}&hall=${hall}&period=${period}`;
