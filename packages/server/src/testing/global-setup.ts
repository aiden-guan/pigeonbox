/**
 * Vitest global setup: build the migrated PGlite snapshot once per run (or
 * reuse it from a previous run when the migrations have not changed).
 */
import { existsSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSnapshot, SNAPSHOT_ENV, snapshotKey } from './database.js';

export default async function setup(): Promise<void> {
  const file = join(tmpdir(), `pigeonbox-pglite-${snapshotKey()}.tar`);
  if (!existsSync(file)) {
    const data = await buildSnapshot();
    const partial = `${file}.${process.pid}.partial`;
    writeFileSync(partial, new Uint8Array(await data.arrayBuffer()));
    renameSync(partial, file);
  }
  process.env[SNAPSHOT_ENV] = file;
}
