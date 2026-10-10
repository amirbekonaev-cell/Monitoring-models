import { AppDataSource } from '../database/data-source';
import { describeDatabase } from './curated-script-context';
import { Mention } from '../mentions/mention.entity';

/**
 * Полностью очищает ленту и дашборд веб-интерфейса: удаляет ВСЕ строки из таблицы `mentions`.
 *
 * Запуск:
 *   npm run dashboard:reset -- --dry-run   показать, что будет удалено, ничего не трогая
 *   npm run dashboard:reset -- --yes       удалить
 *
 * Зачем он нужен, если выдача бота и так перезаписывает таблицу. Затем, что перезапись случается
 * в момент нажатия кнопки периода, а до первого нажатия в дашборде остаётся то, что накопили
 * прежние каналы сбора (упоминания по ключевым словам, по городам и т.п.). Этот скрипт приводит
 * веб-интерфейс к чистому листу заранее — дальше его наполняет только бот (см.
 * DashboardPublishService).
 *
 * НЕОБРАТИМО и затрагивает ВСЕ упоминания, а не только выдачу бота: вместе со строками пропадает
 * уже определённая тональность, включая ручные правки в веб-интерфейсе (ФТ-11). Поэтому без
 * явного `--yes` скрипт ничего не удаляет, а только показывает план.
 *
 * Чего скрипт НЕ трогает: `sources`, `keywords`, `curated_links` и сами карточки
 * (curated-mentions.data.json). На /search и /status он не влияет — бот читает карточки из
 * файла, а не из базы.
 */

const DRY_RUN = process.argv.includes('--dry-run');
const CONFIRMED = process.argv.includes('--yes');

async function run(): Promise<void> {
  await AppDataSource.initialize();
  const mentionsRepo = AppDataSource.getRepository(Mention);

  // База называется до любой записи намеренно: backend/.env задаёт DATABASE_URL, и он сильнее,
  // чем DB_HOST, — запуск из backend/ идёт не в локальный docker compose, а в базу деплоя.
  console.log(`База: ${describeDatabase()}`);

  const total = await mentionsRepo.count();
  console.log(`Упоминаний в базе (это и видят лента и дашборд): ${total}`);

  if (total === 0) {
    console.log('Удалять нечего — лента и дашборд уже пустые.');
    await AppDataSource.destroy();
    return;
  }

  if (DRY_RUN || !CONFIRMED) {
    console.log(
      '\nНичего не удалено.\n' +
        'Это необратимо: вместе с упоминаниями пропадёт уже определённая тональность, включая ручные правки.\n' +
        'Повторите команду с флагом --yes, чтобы очистить: npm run dashboard:reset -- --yes',
    );
    await AppDataSource.destroy();
    return;
  }

  const result = await mentionsRepo.createQueryBuilder().delete().from(Mention).execute();
  console.log(`\nУдалено упоминаний: ${result.affected ?? 0}. Лента и дашборд пустые.`);
  console.log('Наполнить их заново: нажать кнопку периода в /search — выдача за этот период и окажется в дашборде.');

  await AppDataSource.destroy();
}

run().catch((error) => {
  console.error('dashboard:reset упал:', error);
  process.exit(1);
});
