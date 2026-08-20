import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

export interface HashedSource {
  bytes: Buffer;
  byteSize: number;
  contentSha256: string;
  sourceUri: string;
}

export async function hashFileSource(sourceUri: string): Promise<HashedSource> {
  const bytes = await readFile(sourceUri);
  return {
    bytes,
    byteSize: bytes.byteLength,
    contentSha256: createHash('sha256').update(bytes).digest('hex'),
    sourceUri,
  };
}
