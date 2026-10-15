import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Setting } from '../settings/setting.entity';
import { SearchPeriod, searchWindowLabel } from '../curated/search-window.util';
import { LiveFind } from './live-find.types';
import {
  liveFindsSettingKey,
  parseLiveFinds,
  serializeLiveFinds,
  StoredLiveFinds,
} from './live-find-store.util';

/** Нет находок — нет и момента сохранения: окно периода тогда считается от «сейчас». */
const EMPTY: StoredLiveFinds = { savedAt: null, finds: [] };

/**
 * Находки живого поиска последнего /search за период — чтобы они дожили до РАЗВОРОТА статей.
 *
 * Зачем хранилище вообще нужно. Выдача /search делается в два шага и в ДВА РАЗНЫХ вызова
 * вебхука: сначала список заголовков, потом, по кнопке «Да, по одной», отдельное сообщение на
 * каждую статью. Между нажатиями от первого вызова не остаётся ничего — на Vercel это вообще
 * может быть другой инстанс функции. Пока находок здесь не было, разворот собирал статьи заново
 * из набора карточек, и найденного живым поиском в нём не оказывалось: статья стояла в списке
 * заголовков, но своего сообщения с пересказом и ссылкой не получала. Повторять живой поиск на
 * каждое нажатие нельзя — он платный, идёт 16–21 с и непостоянен: во второй раз пришёл бы другой
 * набор статей, не тот, что человек только что увидел в списке.
 *
 * Почему `settings`, а не своя таблица. Это ровно то же key-value, что держит флаг сбора
 * (SettingsService), с готовой схемой: ключ `live_finds:<период>`, значение — JSON находок.
 * Отдельная таблица потребовала бы миграции на облачной БД (README, «Деплой на Vercel»: миграции
 * накатываются вручную) и дала бы то же самое.
 *
 * Одна строка на период, и каждый новый /search её ЗАМЕНЯЕТ целиком — та же мысль, по которой
 * живёт публикация в дашборд: в хранилище лежит ровно последняя выдача, а не её история.
 *
 * Падение базы здесь гасится вызывающим (TelegramBotService): без хранилища человек получает то
 * же, что получал раньше — список заголовков и статьи набора по одному сообщению. /search
 * обязан отвечать даже с недоступным Postgres.
 */
@Injectable()
export class LiveFindStoreService {
  private readonly logger = new Logger(LiveFindStoreService.name);

  constructor(
    @InjectRepository(Setting)
    private readonly settingsRepo: Repository<Setting>,
  ) {}

  /** Заменяет находки периода на переданные. Пустой список тоже сохраняется: он означает, что в
   *  этот раз живой поиск не нашёл ничего, и прошлые находки показывать больше нельзя. */
  async save(period: SearchPeriod, finds: readonly LiveFind[], now: Date = new Date()): Promise<void> {
    await this.settingsRepo.upsert(
      { key: liveFindsSettingKey(period), value: serializeLiveFinds(finds, now) },
      ['key'],
    );
    this.logger.log(`Находки живого поиска сохранены для периода «${searchWindowLabel(period)}»: ${finds.length}`);
  }

  /**
   * Находки последнего /search за период вместе с моментом, когда они сохранены. Нет строки или
   * строка не разбирается — пустая запись: выдача останется без находок, но уйдёт человеку.
   */
  async load(period: SearchPeriod): Promise<StoredLiveFinds> {
    const row = await this.settingsRepo.findOne({ where: { key: liveFindsSettingKey(period) } });
    if (!row) {
      return EMPTY;
    }
    const stored = parseLiveFinds(row.value);
    if (stored === null) {
      this.logger.warn(
        `Запись находок живого поиска за «${searchWindowLabel(period)}» не разобрана — ` +
          'в выдаче останется только набор',
      );
      return EMPTY;
    }
    return stored;
  }
}
