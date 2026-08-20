import { access, copyFile, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

import { isPortAvailable } from './ports.mjs';

function command(command, args, message) {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    env: process.env,
  });
  if (result.status !== 0) {
    throw new Error(message ?? `${command} ${args.join(' ')} failed`);
  }
}

function available(commandName, args = ['--version']) {
  return spawnSync(commandName, args, { stdio: 'ignore' }).status === 0;
}

function fail(message) {
  process.stderr.write(`Bootstrap cannot continue:\n${message}\n`);
  process.exit(1);
}

async function loadEnvironment() {
  try {
    await access('.env');
  } catch {
    await copyFile('.env.example', '.env');
  }
  const contents = await readFile('.env', 'utf8');
  for (const line of contents.split(/\r?\n/)) {
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (match && process.env[match[1]] === undefined) {
      process.env[match[1]] = match[2];
    }
  }
}

if (Number(process.versions.node.split('.')[0]) !== 22) {
  fail(`Node 22 is required; found ${process.version}.`);
}
if (!available('pnpm')) fail('pnpm is required. Run: corepack enable');
if (!available('docker')) fail('Docker is required. Install Docker Desktop.');
if (!available('docker', ['compose', 'version'])) {
  fail('The Docker Compose plugin is required.');
}
if (!available('docker', ['info'])) {
  fail('The Docker daemon is not running. Start Docker Desktop, then retry.');
}

try {
  await loadEnvironment();
  const postgresRunning = spawnSync(
    'docker',
    ['compose', 'ps', '--status', 'running', '--services', 'postgres'],
    { encoding: 'utf8' },
  )
    .stdout.split(/\r?\n/)
    .includes('postgres');

  if (!postgresRunning && !(await isPortAvailable('0.0.0.0', 5432))) {
    fail(
      [
        'Postgres port 5432 is already in use by another process.',
        'Identify it with:',
        '  lsof -nP -iTCP:5432 -sTCP:LISTEN',
        '  docker ps --filter publish=5432',
        'Stop that listener, then rerun: pnpm bootstrap',
      ].join('\n'),
    );
  }
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

command('pnpm', ['install', '--frozen-lockfile']);
command('docker', ['compose', 'up', '-d', '--wait', 'postgres']);
command('pnpm', ['db:bootstrap']);
command('pnpm', ['db:migrate']);
command('pnpm', ['ingest', '--', 'data/fixtures/usage_events.json']);

process.stdout.write(
  '\nReady. Next commands:\n  pnpm dev\n  pnpm verify\n  pnpm teardown\n',
);
