const helpFlags = new Set(['-h', '-help', '--help', 'help']);

export type IngestInvocation =
  { kind: 'help' } | { kind: 'usage' } | { kind: 'path'; sourcePath: string };

export const ingestUsage = 'Usage: pnpm ingest -- <path>';

export function parseIngestInvocation(argv: string[]): IngestInvocation {
  const positional = argv.filter((argument) => argument !== '--');
  if (positional.length === 1 && helpFlags.has(positional[0]!)) {
    return { kind: 'help' };
  }
  if (positional.length === 1 && positional[0]) {
    return { kind: 'path', sourcePath: positional[0] };
  }
  return { kind: 'usage' };
}
