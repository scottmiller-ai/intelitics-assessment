import { rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

const full = process.argv.slice(2).includes('--full');
if (spawnSync('docker', ['--version'], { stdio: 'ignore' }).status === 0) {
  spawnSync('docker', ['compose', 'down', '-v', '--remove-orphans'], {
    stdio: 'inherit',
  });
}

const paths = ['dist', 'coverage', '.tmp'];
if (full) paths.push('.env', 'node_modules');
await Promise.all(
  paths.map((target) => rm(target, { recursive: true, force: true })),
);
