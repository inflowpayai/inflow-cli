import {
  decode,
  encode,
  encodeCredential,
  renderChallengeHeader,
} from '../packages/core/node_modules/@inflowpayai/mpp/dist/index.js';
import { decodeMppValue, parseMppHeaderFromProbe } from '../packages/core/dist/index.js';

const operationErrorTypes = {
  'challenge.format': 'format_error',
  'challenge.parse': 'parse_error',
  'credential.format': 'format_error',
  'credential.parse': 'parse_error',
  'receipt.format': 'format_error',
  'receipt.parse': 'parse_error',
};

function requireRecord(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value;
}

function requireString(value, label) {
  if (typeof value !== 'string') throw new TypeError(`${label} must be a string`);
  return value;
}

function parseChallenge(header) {
  const result = parseMppHeaderFromProbe({
    status: 402,
    headers: { 'www-authenticate': header },
    contentType: undefined,
    bytes: new Uint8Array(),
  });
  if (result.kind !== 'parsed' || result.challenges.length !== 1) {
    throw new Error(result.kind === 'error' ? result.message : 'Expected one MPP challenge');
  }
  const challenge = result.challenges[0];
  if (challenge === undefined) throw new Error('Expected one MPP challenge');
  return { ...challenge, request: decode(challenge.request, 'challenge request') };
}

function parseCredential(header) {
  const token = header.replace(/^Payment\s+/i, '');
  if (token === header) throw new Error('Missing Payment scheme');
  const result = decodeMppValue(token);
  if (result.kind !== 'credential') throw new Error('Expected an MPP credential');
  return {
    ...result.credential,
    challenge: { ...result.credential.challenge, request: decode(result.credential.challenge.request) },
  };
}

function parseReceipt(header) {
  const result = decodeMppValue(header);
  if (result.kind !== 'receipt') throw new Error('Expected an MPP receipt');
  return result.receipt;
}

function execute(op, rawInput) {
  const input = requireRecord(rawInput, 'input');
  switch (op) {
    case 'challenge.parse':
      return parseChallenge(requireString(input.header, 'header'));
    case 'challenge.format':
      return { header: renderChallengeHeader({ ...input, request: encode(requireRecord(input.request, 'request')) }) };
    case 'credential.parse':
      return parseCredential(requireString(input.header, 'header'));
    case 'credential.format': {
      const challenge = requireRecord(input.challenge, 'challenge');
      return {
        header: `Payment ${encodeCredential({ ...input, challenge: { ...challenge, request: encode(requireRecord(challenge.request, 'challenge.request')) } })}`,
      };
    }
    case 'receipt.parse':
      return parseReceipt(requireString(input.header, 'header'));
    case 'receipt.format':
      return { header: encode(input) };
    default:
      throw new Error(`Unsupported operation: ${op}`);
  }
}

let source = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) source += chunk;

let request;
try {
  request = JSON.parse(source);
  const value = execute(requireString(request.op, 'op'), request.input);
  process.stdout.write(JSON.stringify({ ok: true, value }));
} catch (cause) {
  const type = operationErrorTypes[request?.op] ?? 'unknown_error';
  const message = cause instanceof Error ? cause.message : String(cause);
  process.stdout.write(JSON.stringify({ ok: false, error: { type, message } }));
}
