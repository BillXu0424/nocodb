/**
 * 本地调试用：PostgreSQL 做元数据库，每个 Base 在同一个 PG 里占一个 schema（Data Reflection）。
 * NC_DB 可在本目录的 .env 里配置（见 .env.example），未设置时用下方默认值。
 */
import dns from 'node:dns';
import cors from 'cors';
import express from 'express';
import Noco from '~/Noco';
import { handleUncaughtErrors } from '~/utils';
handleUncaughtErrors(process);

dns.setDefaultResultOrder('ipv4first');

const server = express();
server.enable('trust proxy');
server.disable('etag');
server.disable('x-powered-by');
server.use(
  cors({
    exposedHeaders: 'xc-db-response',
  }),
);
server.set('view engine', 'ejs');

if (!process.env.NC_DB) {
  process.env.NC_DB =
    'pg://localhost:5432?u=postgres&p=password&d=postgres';
}
// 不设置 NC_DISABLE_PG_DATA_REFLECTION，即每个 Base 一个 schema

(async () => {
  const httpServer = server.listen(process.env.PORT || 8080, async () => {
    server.use(await Noco.init({}, httpServer, server));
  });
})().catch((e) => console.log(e));
