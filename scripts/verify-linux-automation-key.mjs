#!/usr/bin/env node
import { execFileSync } from 'node:child_process';

const expectedFingerprint = normalizedFingerprint(process.argv[2] ?? '');
const records = execFileSync(
  'gpg',
  ['--batch', '--with-colons', '--with-subkey-fingerprint', '--list-secret-keys', expectedFingerprint],
  { encoding: 'utf8' },
)
  .trim()
  .split('\n')
  .map((line) => line.split(':'));
const primary = records.find((record) => record[0] === 'sec');
const primaryFingerprint = records.find((record) => record[0] === 'fpr')?.[9] ?? '';
const subkeys = records.filter((record) => record[0] === 'ssb');

if (normalizedFingerprint(primaryFingerprint) !== expectedFingerprint) {
  throw new Error('The automation key primary fingerprint does not match the protected environment.');
}
if (primary?.[14] !== '#') {
  throw new Error('The automation key contains a usable primary secret key.');
}
if (
  subkeys.length !== 1 ||
  subkeys[0]?.[14] !== '+' ||
  !(subkeys[0]?.[11] ?? '').toLowerCase().includes('s')
) {
  throw new Error('The automation key must contain exactly one usable signing subkey.');
}

process.stdout.write(`Verified automation-only Linux signing key ${expectedFingerprint}.\n`);

function normalizedFingerprint(value) {
  const normalized = value.replaceAll(/\s/gu, '').toUpperCase();
  if (!/^[0-9A-F]{40,64}$/u.test(normalized)) throw new Error('Linux signing-key fingerprint is invalid.');
  return normalized;
}
