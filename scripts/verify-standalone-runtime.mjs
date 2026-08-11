#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import ts from 'typescript';

const bundlePath = resolve('packages/cli/dist/cli.standalone.mjs');
const source = readFileSync(bundlePath, 'utf8');
const module = ts.createSourceFile(bundlePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const dynamicImports = [];
visit(module);
const nonLiteralImports = dynamicImports
  .filter((argument) => !ts.isStringLiteral(argument))
  .map((argument) => argument.getText(module));
const supportedRuntimeImports = new Set([...builtinModules, ...builtinModules.map((name) => `node:${name}`)]);
const unsupportedLiteralImports = dynamicImports
  .filter(ts.isStringLiteral)
  .map(({ text }) => text)
  .filter((specifier) => !supportedRuntimeImports.has(specifier));

if (nonLiteralImports.length > 0) {
  throw new Error(`Standalone bundle contains non-literal dynamic imports: ${nonLiteralImports.join(', ')}`);
}
if (unsupportedLiteralImports.length > 0) {
  throw new Error(`Standalone bundle contains unresolved runtime imports: ${unsupportedLiteralImports.join(', ')}`);
}

function visit(node) {
  if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
    const argument = node.arguments[0];
    if (argument !== undefined) dynamicImports.push(argument);
  }
  ts.forEachChild(node, visit);
}

const evaluation = [
  "const { readFileSync } = require('node:fs');",
  "process.argv = [process.execPath, 'inflow', 'mcp', 'doctor'];",
  `const encoded = readFileSync(${JSON.stringify(bundlePath)}).toString('base64');`,
  'import(`data:text/javascript;base64,${encoded}`).catch((error) => {',
  '  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\\n`);',
  '  process.exitCode = 1;',
  '});',
].join('\n');
const result = spawnSync(process.execPath, ['--eval', evaluation], {
  encoding: 'utf8',
  env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '' },
  maxBuffer: 2 * 1024 * 1024,
});

if (result.status !== 0 || !result.stdout.includes('ok: true') || !/toolCount: [1-9]\d*/.test(result.stdout)) {
  const output = `${result.stdout}\n${result.stderr}`.trim().slice(0, 4000);
  throw new Error(`Standalone data-URL MCP diagnostic failed:\n${output}`);
}

process.stdout.write('Standalone data-URL runtime verification passed.\n');
