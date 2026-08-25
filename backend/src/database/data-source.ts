import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { config } from 'dotenv';
import { Source } from '../sources/source.entity';
import { Mention } from '../mentions/mention.entity';
import { Keyword } from '../keywords/keyword.entity';

config();

export const AppDataSource = new DataSource({
  type: 'postgres',
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT) || 5432,
  username: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
  database: process.env.DB_NAME || 'mentions',
  entities: [Source, Mention, Keyword],
  migrations: [__dirname + '/migrations/*.{ts,js}'],
  synchronize: false,
});
