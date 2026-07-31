#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const archiveUrl = 'https://github.com/P-H-C/phc-winner-argon2/archive/refs/tags/20190702.tar.gz';
const archiveSha256 = 'daf972a89577f8772602bf2eb38b6a3dd3d922bf5724d45e7f9589b5e830442c';
const destination = resolve(process.argv[2] ?? 'dist/native-sources/argon2-20190702');
const archive = `${destination}.tar.gz`;

rmSync(destination, { force: true, recursive: true });
mkdirSync(destination, { recursive: true });

const response = await fetch(archiveUrl, { redirect: 'follow' });
if (!response.ok) throw new Error(`Argon2 source download failed with HTTP ${response.status}.`);
const bytes = Buffer.from(await response.arrayBuffer());
const actualSha256 = createHash('sha256').update(bytes).digest('hex');
if (actualSha256 !== archiveSha256) {
  bytes.fill(0);
  throw new Error(`Argon2 source checksum mismatch: ${actualSha256}.`);
}

writeFileSync(archive, bytes, { mode: 0o600 });
bytes.fill(0);
try {
  execFileSync('tar', ['-xzf', archive, '--strip-components=1', '-C', destination], { stdio: 'inherit' });
} finally {
  rmSync(archive, { force: true });
}

process.stdout.write(`${destination}\n`);
