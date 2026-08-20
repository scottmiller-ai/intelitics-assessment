import 'dotenv/config';
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
  migrations: {
    schema: 'app',
    table: '__drizzle_migrations',
  },
  dbCredentials: {
    url:
      process.env.MIGRATOR_DATABASE_URL ??
      'postgres://migrator:migrator@localhost:5432/intelitics',
  },
  strict: true,
  verbose: true,
});
