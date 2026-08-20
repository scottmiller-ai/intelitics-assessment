import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

import { isPortAvailable, parsePort } from './ports.mjs';

const required = [
  'POSTGRES_ADMIN_URL',
  'MIGRATOR_DATABASE_URL',
  'INGEST_DATABASE_URL',
  'TENANT_DATABASE_URL',
  'BILLING_ADMIN_DATABASE_URL',
];

function fail(reason, nextStep = 'Run pnpm bootstrap') {
  process.stderr.write(`${reason}.\n${nextStep}\n`);
  process.exit(1);
}

function succeeds(command, args) {
  return spawnSync(command, args, { stdio: 'ignore' }).status === 0;
}

if (!succeeds('docker', ['info'])) fail('Docker daemon is unavailable');
const postgresState = spawnSync(
  'docker',
  ['compose', 'ps', '--format', 'json', 'postgres'],
  { encoding: 'utf8' },
);
if (
  postgresState.status !== 0 ||
  !postgresState.stdout.includes('"Service":"postgres"') ||
  !postgresState.stdout.includes('"Health":"healthy"')
) {
  fail('Compose postgres service is not running');
}

let contents;
try {
  contents = await readFile('.env', 'utf8');
} catch {
  fail('.env is missing');
}
for (const line of contents.split(/\r?\n/)) {
  const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
  if (match && process.env[match[1]] === undefined)
    process.env[match[1]] = match[2];
}
for (const name of required) {
  if (!process.env[name]) fail(`${name} is missing`);
}

let apiPort;
try {
  apiPort = parsePort(process.env.PORT ?? '3000', 'PORT');
} catch (error) {
  fail(
    error instanceof Error ? error.message : String(error),
    'Correct PORT in .env, then rerun pnpm dev',
  );
}
const apiHost = process.env.HOST ?? '127.0.0.1';
if (!(await isPortAvailable(apiHost, apiPort))) {
  fail(
    `API address ${apiHost}:${apiPort} is already in use`,
    [
      `Stop the listener or set PORT to an available port in .env.`,
      `Identify it with: lsof -nP -iTCP:${apiPort} -sTCP:LISTEN`,
    ].join('\n'),
  );
}

try {
  const { default: postgres } = await import('postgres');
  const sql = postgres(process.env.TENANT_DATABASE_URL, {
    max: 1,
    connect_timeout: 3,
  });
  try {
    await sql`select 1`;
  } finally {
    await sql.end();
  }
} catch {
  fail('Database is unavailable');
}
