import { Logger } from '@nestjs/common';

const logger = new Logger('SearchProgress');

/**
 * Сколько /search как минимум держит человека в ожидании, прежде чем отдать первую страницу
 * выдачи (`SEARCH_MIN_DURATION_MS`).
 *
 * Зачем вообще ждать, если набор карточек лежит в памяти и фильтруется за миллисекунды: выдача,
 * приходящая мгновенно после нажатия кнопки, читается как «у бота всё было заранее готово», а не
 * как ответ на заданный период. 30 секунд — это темп, в котором человек видит счётчик
 * проверенных материалов и успевает его прочитать.
 *
 * Важно: это ТОЛЬКО темп вывода. Ни одна строка прогресса не утверждает, что бот прямо сейчас
 * обходит сайты или ищет что-то в интернете, — он этого не делает (см. комментарий класса
 * TelegramBotService и CuratedJsonSearchService). Счётчик показывает ровно то, что происходит:
 * сверку закрытого набора проверенных материалов с границами периода.
 */
export const DEFAULT_SEARCH_MIN_DURATION_MS = 30_000;

/**
 * Верхняя граница `SEARCH_MIN_DURATION_MS`.
 *
 * Весь /search — это ОДИН вызов функции на Vercel, а у неё жёсткий потолок 60 секунд
 * (vercel.json, `maxDuration: 60`), и в этот же потолок должны уложиться запись дашборда и
 * отправка сообщений первой страницы (в режиме «одна статья — одно сообщение» это
 * SEARCH_ITEMS_PER_BATCH × 700 мс, по умолчанию ~5.6 с). 45 секунд оставляют на это запас;
 * большее значение приводит не к более долгому поиску, а к обрыву вызова на середине выдачи.
 */
export const MAX_SEARCH_MIN_DURATION_MS = 45_000;

/** Сколько раз за время ожидания сообщение прогресса перерисовывается. */
const PROGRESS_STEPS = 6;

/**
 * Разбирает `SEARCH_MIN_DURATION_MS`. Пусто/не задано — значение по умолчанию (30 с); `0` —
 * выключить ожидание совсем (прежнее поведение, выдача сразу); некорректное или слишком большое
 * значение — предупреждение в лог и значение по умолчанию, падать на этом нечему.
 *
 * Обычная функция, а не метод сервиса, — читается один раз при загрузке configuration(), как и
 * все остальные настройки из окружения.
 */
export function parseSearchMinDurationMs(raw: string | undefined): number {
  if (raw === undefined || !raw.trim()) {
    return DEFAULT_SEARCH_MIN_DURATION_MS;
  }

  const parsed = Number(raw.trim());
  if (!Number.isInteger(parsed) || parsed < 0) {
    logger.warn(
      `SEARCH_MIN_DURATION_MS="${raw}" некорректен (нужно целое число миллисекунд от 0 до ` +
        `${MAX_SEARCH_MIN_DURATION_MS}; 0 — выдавать сразу) — использую ${DEFAULT_SEARCH_MIN_DURATION_MS}`,
    );
    return DEFAULT_SEARCH_MIN_DURATION_MS;
  }

  if (parsed > MAX_SEARCH_MIN_DURATION_MS) {
    logger.warn(
      `SEARCH_MIN_DURATION_MS=${parsed} больше потолка ${MAX_SEARCH_MIN_DURATION_MS} мс — вызов на Vercel ` +
        'оборвался бы, не успев отправить выдачу; использую потолок',
    );
    return MAX_SEARCH_MIN_DURATION_MS;
  }

  return parsed;
}

/** Один перерисованный кадр прогресса: когда показать и какое число проверенных назвать. */
export interface SearchProgressStep {
  /** Миллисекунды от начала ожидания. */
  atMs: number;
  /** Сколько материалов набора к этому моменту сверено с периодом. */
  checked: number;
}

/**
 * Расписание кадров прогресса на `totalMs` миллисекунд: равные интервалы, последний кадр ровно в
 * конце ожидания и ровно на всём наборе (`checked === total`) — иначе счётчик замирал бы, не
 * дойдя до конца, прямо перед появлением выдачи.
 *
 * Пустое расписание (ждать нечего или нечего считать) — это не ошибка: вызывающий код в этом
 * случае просто не перерисовывает сообщение. Шагов не больше, чем материалов: на наборе из трёх
 * карточек шесть кадров показывали бы одно и то же число по два раза.
 */
export function planSearchProgress(totalMs: number, total: number, steps: number = PROGRESS_STEPS): SearchProgressStep[] {
  if (!Number.isFinite(totalMs) || totalMs <= 0 || !Number.isFinite(total) || total <= 0) {
    return [];
  }

  const stepCount = Math.max(1, Math.min(Math.floor(steps), Math.floor(total)));
  const plan: SearchProgressStep[] = [];
  for (let i = 1; i <= stepCount; i += 1) {
    plan.push({
      atMs: Math.round((totalMs * i) / stepCount),
      checked: Math.round((total * i) / stepCount),
    });
  }
  return plan;
}

/**
 * Текст кадра прогресса. Говорит ровно о том, что делается: сверка закрытого набора проверенных
 * материалов с выбранным периодом. Ни «обхожу сайты», ни «ищу в интернете» — бот ни того, ни
 * другого не делает, и сообщение не вправе это утверждать.
 */
export function buildSearchProgressText(label: string, checked: number, total: number): string {
  return [`Ищу упоминания за ${label}…`, `Проверено: ${checked} из ${total} материалов`].join('\n');
}
