import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { config } from 'dotenv';
import { Source } from '../sources/source.entity';
import { Mention } from '../mentions/mention.entity';
import { Keyword } from '../keywords/keyword.entity';
import { Setting } from '../settings/setting.entity';
import { resolveDbConfig } from '../config/database.util';

config();

const db = resolveDbConfig();

export const AppDataSource = new DataSource({
  type: 'postgres',
  host: db.host,
  port: db.port,
  username: db.username,
  password: db.password,
  database: db.database,
  ssl: db.ssl,
  entities: [Source, Mention, Keyword, Setting],
  migrations: [__dirname + '/migrations/*.{ts,js}'],
  synchronize: false,
});
