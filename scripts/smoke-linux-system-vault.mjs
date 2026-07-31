#!/usr/bin/env node
import { spawn } from 'node:child_process';
import {
  closeSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readlinkSync,
  readSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
} from 'node:fs';
import { createServer } from 'node:http';

const executable = realpathSync(process.env.INFLOW_PACKAGED_EXECUTABLE ?? '/usr/bin/inflow');
const upgradePackage = process.env.INFLOW_UPGRADE_PACKAGE;
const downgradePackage = process.env.INFLOW_DOWNGRADE_PACKAGE;
const unlockOnly = process.env.INFLOW_UNLOCK_ONLY === '1';
const testHome = mkdtempSync('/tmp/inflow-system-vault-');
const passphrase = `system-vault-factor-${process.pid}`;
const apiKey = `system_vault_api_key_${process.pid}`;
const environment = { ...process.env, HOME: testHome, NO_UPDATE_NOTIFIER: '1' };
const secretFiles = ['/var/lib/inflow', '/var/lib/inflow-broker'];

if (process.platform !== 'linux' || process.getuid?.() !== 0) {
  throw new Error('The Linux system-vault smoke requires Linux root.');
}
if ((upgradePackage === undefined) !== (downgradePackage === undefined)) {
  throw new Error('Upgrade and downgrade package paths must be provided together.');
}

let server;
try {
  await assertSystemService();
  const endpoint = await startUserServer();
  await runPty([executable, 'vault', 'unlock'], passphrase, 'Vault initialized and unlocked.');
  assertRuntimeSecurity();
  assertSecretsAbsentFromFiles();
  assertSecretsAbsentFromServiceMemory();
  if (unlockOnly) {
    process.stdout.write('Packaged Linux system vault unlock security smoke passed.\n');
  } else {
    await expectJson([executable, '--api-key', apiKey, '--base-url', endpoint, 'auth', 'login', '--format', 'json'], {
      authenticated: true,
      method: 'api_key',
    });
    await expectJson([executable, 'auth', 'status', '--format', 'json'], {
      auth_method: 'api_key',
      authenticated: true,
    });
    assertRuntimeSecurity();
    assertSecretsAbsentFromFiles();
    assertSecretsAbsentFromServiceMemory();

    if (upgradePackage !== undefined && downgradePackage !== undefined) {
      await verifyPackageReplacement(upgradePackage, 'upgrade');
      await verifyPackageReplacement(downgradePackage, 'downgrade');
    }

    process.stdout.write('Packaged Linux system vault security smoke passed.\n');
  }
} finally {
  server?.close();
  rmSync(testHome, { force: true, recursive: true });
}

async function verifyPackageReplacement(packagePath, direction) {
  const installedVersion = (await runChecked(['dpkg-query', '-W', '-f=${Version}', 'inflow'])).stdout.trim();
  const replacementVersion = (await runChecked(['dpkg-deb', '-f', packagePath, 'Version'])).stdout.trim();
  const comparison = direction === 'upgrade' ? 'gt' : 'lt';
  const comparisonResult = await run(['dpkg', '--compare-versions', replacementVersion, comparison, installedVersion]);
  if (comparisonResult.code !== 0) {
    throw new Error(
      `Expected ${direction} package ${replacementVersion} to be ${comparison} installed ${installedVersion}.`,
    );
  }

  const brokerKey = readFileSync('/var/lib/inflow-broker/public.der');
  const oldBrokerPid = serviceProcess('vault-broker');
  await runChecked(['dpkg', '-i', packagePath]);
  await expectJson([executable, 'vault', 'status', '--format', 'json'], { lock_state: 'locked' });
  const newBrokerPid = serviceProcess('vault-broker');
  if (newBrokerPid === oldBrokerPid) throw new Error(`The vault broker did not restart during package ${direction}.`);
  if (!brokerKey.equals(readFileSync('/var/lib/inflow-broker/public.der'))) {
    throw new Error(`The broker machine identity changed during package ${direction}.`);
  }

  await runPty([executable, 'vault', 'unlock'], passphrase, 'Vault unlocked.');
  await expectJson([executable, 'auth', 'status', '--format', 'json'], {
    auth_method: 'api_key',
    authenticated: true,
  });
  assertRuntimeSecurity();
  assertSecretsAbsentFromFiles();
  assertSecretsAbsentFromServiceMemory();
}

async function assertSystemService() {
  await runChecked(['systemctl', 'is-active', 'inflow-vault.socket']);
  await expectJson([executable, 'vault', 'lock', '--format', 'json'], { locked: true });
  const socket = statSync('/run/inflow/vault.sock');
  if (!socket.isSocket() || socket.uid !== 0 || (socket.mode & 0o777) !== 0o666) {
    throw new Error('The system vault socket identity or permissions are invalid.');
  }
}

function assertRuntimeSecurity() {
  const brokerPid = serviceProcess('vault-broker');
  const vaultPid = serviceProcess('vault-service');
  const brokerStatus = readFileSync(`/proc/${brokerPid}/status`, 'utf8');
  const vaultStatus = readFileSync(`/proc/${vaultPid}/status`, 'utf8');
  expectStatusValue(brokerStatus, 'CapEff', '00000000000800c0');
  expectStatusValue(brokerStatus, 'NoNewPrivs', '1');
  expectStatusValue(vaultStatus, 'CapEff', '0000000000000000');
  expectStatusValue(vaultStatus, 'CapPrm', '0000000000000000');
  expectStatusValue(vaultStatus, 'NoNewPrivs', '1');

  for (const descriptor of readdirSync(`/proc/${brokerPid}/fd`)) {
    let target;
    try {
      target = readlinkSync(`/proc/${brokerPid}/fd/${descriptor}`);
    } catch {
      continue;
    }
    if (target.startsWith('/var/lib/inflow/vaults/')) {
      throw new Error(`The authentication broker opened tenant vault state: ${target}`);
    }
  }
}

function expectStatusValue(status, name, expected) {
  const match = new RegExp(`^${name}:\\s*(\\S+)`, 'm').exec(status);
  if (match?.[1] !== expected) throw new Error(`Expected ${name}=${expected}, received ${match?.[1] ?? 'missing'}.`);
}

function assertSecretsAbsentFromFiles() {
  const secrets = sensitiveValues();
  try {
    for (const root of secretFiles) {
      for (const file of files(root)) {
        const contents = readFileSync(file);
        for (const { bytes, label } of secrets) {
          if (contents.includes(bytes)) throw new Error(`The ${label} was found in plaintext in ${file}.`);
        }
      }
    }
  } finally {
    for (const { bytes } of secrets) bytes.fill(0);
  }
}

function assertSecretsAbsentFromServiceMemory() {
  if (readFileSync('/proc/swaps', 'utf8').trim().split('\n').length !== 1) {
    throw new Error('The plaintext memory scan requires swap to be disabled.');
  }
  const secrets = sensitiveValues();
  try {
    for (const mode of ['vault-broker', 'vault-service']) {
      scanProcessMemory(serviceProcess(mode), mode, secrets);
    }
  } finally {
    for (const { bytes } of secrets) bytes.fill(0);
  }
}

function scanProcessMemory(pid, mode, secrets) {
  const descriptor = openSync(`/proc/${pid}/mem`, 'r');
  const longestSecret = Math.max(...secrets.map(({ bytes }) => bytes.byteLength));
  const chunk = Buffer.alloc(1024 * 1024 + longestSecret - 1);
  try {
    for (const [start, end, mapping] of residentWritableMemoryRanges(pid)) {
      let position = start;
      let overlap = 0;
      while (position < end) {
        const requested = Math.min(1024 * 1024, end - position);
        let bytesRead;
        try {
          bytesRead = readSync(descriptor, chunk, overlap, requested, position);
        } catch (cause) {
          if (cause?.code === 'EIO' || cause?.code === 'EFAULT') break;
          throw cause;
        }
        if (bytesRead === 0) break;
        const populated = overlap + bytesRead;
        for (const { bytes, label } of secrets) {
          const offset = chunk.subarray(0, populated).indexOf(bytes);
          if (offset >= 0) {
            throw new Error(
              `The ${label} remained in ${mode} memory at ${(position - overlap + offset).toString(16)} (${mapping}).`,
            );
          }
        }
        overlap = Math.min(longestSecret - 1, populated);
        chunk.copyWithin(0, populated - overlap, populated);
        chunk.fill(0, overlap, populated);
        position += bytesRead;
      }
      chunk.fill(0);
    }
  } finally {
    chunk.fill(0);
    closeSync(descriptor);
  }
}

function residentWritableMemoryRanges(pid) {
  const pageSizeMatch = /^KernelPageSize:\s+(\d+)\s+kB$/m.exec(readFileSync(`/proc/${pid}/smaps`, 'utf8'));
  const pageSize = Number.parseInt(pageSizeMatch?.[1] ?? '', 10) * 1024;
  if (!Number.isSafeInteger(pageSize) || pageSize <= 0) throw new Error('The Linux page size is unavailable.');
  const mappings = readFileSync(`/proc/${pid}/maps`, 'utf8')
    .split('\n')
    .flatMap((line) => {
      const header = /^([0-9a-f]+)-([0-9a-f]+)\s+(rw..)\s/.exec(line);
      if (header === null) return [];
      const start = Number.parseInt(header[1], 16);
      const end = Number.parseInt(header[2], 16);
      return Number.isSafeInteger(start) && Number.isSafeInteger(end) && end > start ? [{ end, line, start }] : [];
    });
  const ranges = [];
  const pagemap = openSync(`/proc/${pid}/pagemap`, 'r');
  const presentBit = 1n << 63n;
  try {
    for (const mapping of mappings) {
      const pageCount = Math.ceil((mapping.end - mapping.start) / pageSize);
      const entries = Buffer.alloc(pageCount * 8);
      const bytesRead = readSync(pagemap, entries, 0, entries.byteLength, (mapping.start / pageSize) * 8);
      if (bytesRead !== entries.byteLength) throw new Error('The Linux pagemap is truncated.');
      let runStart;
      for (let page = 0; page < pageCount; page += 1) {
        const address = mapping.start + page * pageSize;
        const present = (entries.readBigUInt64LE(page * 8) & presentBit) !== 0n;
        if (present && runStart === undefined) runStart = address;
        if (!present && runStart !== undefined) {
          ranges.push([runStart, address, mapping.line]);
          runStart = undefined;
        }
      }
      if (runStart !== undefined) ranges.push([runStart, mapping.end, mapping.line]);
      entries.fill(0);
    }
  } finally {
    closeSync(pagemap);
  }
  return ranges;
}

function serviceProcess(mode) {
  const candidates = readdirSync('/proc')
    .filter((name) => /^\d+$/.test(name))
    .map(Number)
    .filter((pid) => {
      try {
        if (readlinkSync(`/proc/${pid}/exe`) !== executable) return false;
        return readFileSync(`/proc/${pid}/cmdline`).includes(Buffer.from(`--daemon\0${mode}\0`));
      } catch {
        return false;
      }
    });
  if (candidates.length !== 1) throw new Error(`Expected one ${mode} process, found ${candidates.length}.`);
  return candidates[0];
}

function sensitiveValues() {
  return [
    ...sensitiveRepresentations(passphrase, 'unlock factor'),
    ...sensitiveRepresentations(apiKey, 'stored credential'),
  ];
}

function sensitiveRepresentations(value, label) {
  const bytes = Buffer.from(value, 'utf8');
  return [
    { bytes, label },
    { bytes: Buffer.from(bytes.toString('base64'), 'ascii'), label: `Base64-encoded ${label}` },
    { bytes: Buffer.from(bytes.toString('hex'), 'ascii'), label: `hexadecimal ${label}` },
    { bytes: Buffer.from(value, 'utf16le'), label: `UTF-16 ${label}` },
  ];
}

function files(root) {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = `${root}/${entry.name}`;
    if (entry.isDirectory()) return files(entryPath);
    return entry.isFile() ? [entryPath] : [];
  });
}

function startUserServer() {
  return new Promise((resolveEndpoint, reject) => {
    server = createServer((request, response) => {
      if (request.url !== '/v1/users/self' || request.headers['x-api-key'] !== apiKey) {
        response.writeHead(401, { 'content-type': 'application/json' });
        response.end('{"code":"unauthorized"}');
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"id":"system-vault-user","email":"system-vault@inflow.test"}');
    });
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('Could not determine the system-vault smoke server address.'));
        return;
      }
      resolveEndpoint(`http://127.0.0.1:${address.port}`);
    });
  });
}

async function expectJson(command, expected) {
  const result = await runChecked(command);
  const value = JSON.parse(result.stdout);
  const frame = (Array.isArray(value) ? value : [value]).at(-1);
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (frame?.[key] !== expectedValue) {
      throw new Error(`Expected ${key}=${JSON.stringify(expectedValue)} from ${command.join(' ')}.`);
    }
  }
}

async function runPty(command, input, expectedOutput) {
  const commandText = command.map(shellQuote).join(' ');
  const result = await new Promise((resolveRun, reject) => {
    const child = spawn('script', ['-qec', commandText, '/dev/null'], {
      env: environment,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    let answered = false;
    child.stdout.on('data', (chunk) => {
      stdout.push(chunk);
      if (!answered && Buffer.concat(stdout).includes(Buffer.from('passphrase: '))) {
        answered = true;
        child.stdin.end(`${input}\n`);
      }
    });
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.once('error', reject);
    child.once('close', (code) => {
      resolveRun({
        code: code ?? 1,
        stderr: Buffer.concat(stderr).toString('utf8'),
        stdout: Buffer.concat(stdout).toString('utf8'),
      });
    });
  });
  if (result.code !== 0 || !`${result.stdout}\n${result.stderr}`.includes(expectedOutput)) {
    throw commandFailure(command, result);
  }
}

async function runChecked(command) {
  const result = await run(command);
  if (result.code !== 0) throw commandFailure(command, result);
  return result;
}

function run(command, childEnvironment = environment) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command[0], command.slice(1), {
      env: childEnvironment,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.once('error', reject);
    child.once('close', (code) => {
      resolveRun({
        code: code ?? 1,
        stderr: Buffer.concat(stderr).toString('utf8'),
        stdout: Buffer.concat(stdout).toString('utf8'),
      });
    });
  });
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function commandFailure(command, result) {
  return new Error(
    [
      `Command failed: ${command.join(' ')}`,
      `exit: ${result.code}`,
      `stdout: ${result.stdout.trim()}`,
      `stderr: ${result.stderr.trim()}`,
    ].join('\n'),
  );
}
