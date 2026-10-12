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
 * За это же время внутри паузы действительно идёт работа: опрашиваются RSS-ленты изданий и
 * веб-поиск по открытому интернету (см. LiveSearchService). Поэтому пауза — это не только темп
 * вывода: к моменту её окончания живой поиск, как правило, уже отработал.
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

/** Один перерисованный кадр прогресса: когда показать и какой процент назвать. */
export interface SearchProgressStep {
  /** Миллисекунды от начала ожидания. */
  atMs: number;
  /** Процент готовности, который показывается в этом кадре (последний кадр — 100). */
  percent: number;
}

/**
 * Расписание кадров прогресса на `totalMs` миллисекунд: равные интервалы, последний кадр ровно в
 * конце ожидания и ровно на 100% — иначе счётчик замирал бы, не дойдя до конца, прямо перед
 * появлением выдачи.
 *
 * Пустое расписание (ждать нечего) — это не ошибка: вызывающий код в этом случае просто не
 * перерисовывает сообщение.
 */
export function planSearchProgress(totalMs: number, steps: number = PROGRESS_STEPS): SearchProgressStep[] {
  if (!Number.isFinite(totalMs) || totalMs <= 0) {
    return [];
  }

  const stepCount = Math.max(1, Math.floor(Number.isFinite(steps) && steps > 0 ? steps : PROGRESS_STEPS));
  const plan: SearchProgressStep[] = [];
  for (let i = 1; i <= stepCount; i += 1) {
    plan.push({
      atMs: Math.round((totalMs * i) / stepCount),
      percent: Math.round((100 * i) / stepCount),
    });
  }
  return plan;
}

/**
 * Текст кадра прогресса — две короткие строки: что ищется и насколько готово.
 *
 * Процент, а не «проверено N из 166»: сколько у бота материалов и откуда они — его внутреннее
 * устройство, и в сообщении пользователю ему места нет. Человек спросил про упоминания за период,
 * ему и отвечаем — поиском и его результатом.
 */
export function buildSearchProgressText(label: string, percent: number): string {
  return `Ищу упоминания за ${label}… ${percent}%`;
}
