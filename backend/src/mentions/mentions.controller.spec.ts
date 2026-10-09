import { BadRequestException } from '@nestjs/common';
import { MentionsController } from './mentions.controller';
import { MentionsService } from './mentions.service';
import { ALL_TIME_PERIOD_DAYS } from '../curated/search-period.util';

/**
 * Focus: resolveRange()'s period presets — the exact bug found live. The frontend's period
 * picker only had 'today'/'7d'/'30d', so the closed pool's historical mentions (dates spanning
 * years, backfilled all at once) fell outside every preset by default: /mentions with no period
 * returned 177 items, but every period-scoped feed/dashboard view showed close to none. Widened
 * to match the Telegram bot's picker (curated/search-period.util.ts DEFAULT_SEARCH_PERIOD_DAYS),
 * and an unrecognised period now fails loud (BadRequestException) instead of the old silent
 * fallback to 7 days — the same silent fallback that made this bug hard to notice while debugging
 * this via curl (`period=730` doesn't exist there either — days go through `730d`).
 */
describe('MentionsController — период /mentions и /mentions/stats', () => {
  function makeController() {
    const findRecent = jest.fn(async () => ({ items: [], total: 0 }));
    const getStats = jest.fn(async (_params: any) => ({
      total: 0,
      previousTotal: 0,
      changePercent: null,
      byDay: [],
      bySentiment: { positive: 0, negative: 0, neutral: 0, undefined: 0 },
      topSources: [],
    }));
    const service = { findRecent, getStats } as unknown as MentionsService;
    return { controller: new MentionsController(service), findRecent, getStats };
  }

  const PRESETS: [string, number][] = [
    ['7d', 7],
    ['30d', 30],
    ['60d', 60],
    ['90d', 90],
    ['180d', 180],
    ['365d', 365],
    ['730d', 730],
    ['all', ALL_TIME_PERIOD_DAYS],
  ];

  it.each(PRESETS)('resolves period=%s to a %d-day window ending now', async (period, days) => {
    const { controller, getStats } = makeController();
    const before = Date.now();

    await controller.stats(undefined, undefined, undefined, undefined, undefined, period, undefined, undefined);

    const call = getStats.mock.calls[0][0];
    const spanMs = call.dateTo.getTime() - call.dateFrom.getTime();
    // Allow a little slack for the two `new Date()` calls inside resolveRange not landing on the
    // exact same millisecond as `before`.
    expect(spanMs).toBeGreaterThanOrEqual(days * 24 * 60 * 60 * 1000 - 5000);
    expect(spanMs).toBeLessThanOrEqual(days * 24 * 60 * 60 * 1000 + 5000);
    expect(call.dateTo.getTime()).toBeGreaterThanOrEqual(before);
  });

  it('resolves period=today to midnight..now', async () => {
    const { controller, getStats } = makeController();
    await controller.stats(undefined, undefined, undefined, undefined, undefined, 'today', undefined, undefined);
    const call = getStats.mock.calls[0][0];
    expect(call.dateFrom.getHours()).toBe(0);
    expect(call.dateFrom.getMinutes()).toBe(0);
  });

  it('defaults to a 7-day window when no period is given at all', async () => {
    const { controller, getStats } = makeController();
    await controller.stats(undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined);
    const call = getStats.mock.calls[0][0];
    const spanMs = call.dateTo.getTime() - call.dateFrom.getTime();
    expect(spanMs).toBeGreaterThanOrEqual(7 * 24 * 60 * 60 * 1000 - 5000);
  });

  it('rejects an unrecognised period instead of silently falling back to 7 days', async () => {
    const { controller } = makeController();
    await expect(
      controller.stats(undefined, undefined, undefined, undefined, undefined, '730', undefined, undefined),
    ).rejects.toThrow(BadRequestException);
  });

  it('dateFrom/dateTo win over period when both dates are given', async () => {
    const { controller, getStats } = makeController();
    await controller.stats(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      '7d',
      '2018-01-01T00:00:00.000Z',
      '2026-09-29T00:00:00.000Z',
    );
    const call = getStats.mock.calls[0][0];
    expect(call.dateFrom.toISOString()).toBe('2018-01-01T00:00:00.000Z');
    expect(call.dateTo.toISOString()).toBe('2026-09-29T00:00:00.000Z');
  });
});
