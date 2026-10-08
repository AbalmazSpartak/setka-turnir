// База случаев → CSV для Excel и Google Таблиц: одна строка — одна ситуация в одном турнире.
// Разделитель «;» и метка UTF-8 (BOM) — так Excel с русскими настройками открывает файл без мастера импорта.
// Общий код: файл выгружает tools/precedents.mjs, а кнопку «Скачать CSV» собирает страница
import { SITUATIONS, setkaLink } from "./situations.js";

const SITE = "https://abalmazspartak.github.io/setka-turnir/";

const cell = (value) => {
  const text = String(value ?? "");
  return /[;"\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

export function toCSV(data) {
  const titles = Object.fromEntries(SITUATIONS.map((x) => [x.key, x.title]));
  const header = ["Дата", "Турнир", "Ситуация", "Что произошло", "Итог Setka совпал с расчётом", "Ссылка на Setka Cup", "Ссылка на расчёт"];
  const rows = Object.entries(data.tournaments)
    .sort(([idA, a], [idB, b]) => b.date.localeCompare(a.date) || idB - idA)
    .flatMap(([id, t]) => t.situations.map((key) => [
      t.date.split("-").reverse().join("."),
      t.title,
      titles[key] ?? key,
      t.details?.[key] ?? "",
      t.setka === true ? "да" : t.setka === false ? "нет" : "нет итогов Setka",
      setkaLink(t.date, t.hall, t.period),
      `${SITE}?date=${t.date}&t=${id}`,
    ]));
  return "﻿" + [header, ...rows].map((row) => row.map(cell).join(";")).join("\r\n") + "\r\n";
}
