import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

test(
  'macOS archive verification checks extracted binaries, metadata, and startup',
  { skip: process.platform !== 'darwin' },
  () => {
    const directory = mkdtempSync(join(tmpdir(), 'inflow-archive-test-'));
    const app = join(directory, 'InFlow.app');
    const executable = join(app, 'Contents/MacOS/inflow');
    const archive = join(directory, 'inflow.zip');
    const source = join(directory, 'main.c');
    mkdirSync(join(app, 'Contents/MacOS'), { recursive: true });
    writeFileSync(source, '#include <stdio.h>\nint main(void) { puts("1.2.3"); return 0; }\n');
    try {
      execFileSync('cc', ['-mmacosx-version-min=13.5', source, '-o', executable]);
      pack('13.5', '1.2.3');
      let result = verify();
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /Verified extracted macOS archive/u);

      pack('13.0', '1.2.3');
      result = verify();
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /requires macOS 13\.5, but the app declares 13\.0/u);

      const library = join(app, 'Contents/MacOS/module.node');
      execFileSync('cc', ['-dynamiclib', '-mmacosx-version-min=14.0', source, '-o', library]);
      execFileSync('codesign', ['--force', '--sign', '-', library], { stdio: 'pipe' });
      pack('13.5', '1.2.3');
      result = verify();
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /module\.node requires macOS 14\.0, but the app declares 13\.5/u);
      rmSync(library);

      pack('13.5', '9.9.9');
      result = verify();
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /Expected version 9\.9\.9, received 1\.2\.3/u);

      writeFileSync(source, 'int main(void) { return 42; }\n');
      execFileSync('cc', ['-mmacosx-version-min=13.5', source, '-o', executable]);
      pack('13.5', '1.2.3');
      result = verify();
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /status: 42/u);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }

    function pack(minimum, version) {
      writeFileSync(
        join(app, 'Contents/Info.plist'),
        `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>ai.inflowpay.archive-test</string>
<key>CFBundleExecutable</key><string>inflow</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>${version}</string>
<key>LSMinimumSystemVersion</key><string>${minimum}</string>
</dict></plist>`,
      );
      execFileSync('codesign', ['--force', '--sign', '-', app], { stdio: 'pipe' });
      rmSync(archive, { force: true });
      execFileSync('ditto', ['-c', '-k', '--keepParent', app, archive]);
    }

    function verify() {
      return spawnSync(process.execPath, [resolve('scripts/verify-macos-archive.mjs'), archive], { encoding: 'utf8' });
    }
  },
);
