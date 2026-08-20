import { hashFileSource } from './hashSource.js';
import { IngestFailure, ingestHashedSource } from './persistBatch.js';

type CliFailureCode =
  | 'source_unreadable'
  | 'invalid_utf8'
  | 'invalid_json'
  | 'root_not_array'
  | 'database_error';

function safeDetails(error: unknown): string {
  return (error instanceof Error ? error.message : 'Unknown failure')
    .replaceAll(/postgres:\/\/[^@\s]+@/g, 'postgres://***@')
    .slice(0, 500);
}

async function main(): Promise<void> {
  const positional = process.argv
    .slice(2)
    .filter((argument) => argument !== '--');
  const sourcePath = positional[0];
  if (!sourcePath || positional.length !== 1) {
    fail('source_unreadable', 'Usage: pnpm ingest -- <path>');
  }

  let source;
  try {
    source = await hashFileSource(sourcePath);
  } catch (error) {
    fail('source_unreadable', safeDetails(error));
  }

  try {
    const summary = await ingestHashedSource(source);
    process.stdout.write(`${JSON.stringify(summary)}\n`);
  } catch (error) {
    if (error instanceof IngestFailure) fail(error.code, error.message);
    fail('database_error', safeDetails(error));
  }
}

function fail(code: CliFailureCode, details: string): never {
  process.stderr.write(
    `${JSON.stringify({ status: 'failed', error: code, details })}\n`,
  );
  process.exit(1);
}

await main();
