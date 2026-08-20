import 'dotenv/config';
import path from 'node:path';

import postgres from 'postgres';

const adminUrl = process.env.POSTGRES_ADMIN_URL;
if (!adminUrl) {
  throw new Error('Missing required environment variable: POSTGRES_ADMIN_URL');
}

const sql = postgres(adminUrl, { max: 1, onnotice: () => undefined });

try {
  await sql.file(path.resolve('db/bootstrap.sql'));
} finally {
  await sql.end();
}
