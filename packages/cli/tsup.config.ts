import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'tsup';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../..');

interface CliManifest {
  name: string;
  version: string;
}

const manifest = JSON.parse(readFileSync(resolve(here, 'package.json'), 'utf-8')) as CliManifest;

const skillsDir = resolve(repoRoot, 'skills');

const bootstrapPath = resolve(skillsDir, 'skill.md');
const bootstrapBody = extractSkillBody(readFileSync(bootstrapPath, 'utf-8'), bootstrapPath);

const skillBodies: Record<string, string> = {};
const skillEntries = readdirSync(skillsDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
for (const entry of skillEntries) {
  if (!entry.isDirectory()) continue;
  const skillPath = resolve(skillsDir, entry.name, 'SKILL.md');
  if (!existsSync(skillPath)) continue;
  skillBodies[entry.name] = extractSkillBody(readFileSync(skillPath, 'utf-8'), skillPath);
}

function extractSkillBody(source: string, path: string): string {
  if (!source.startsWith('---\n') && !source.startsWith('---\r\n')) {
    return source.trimStart();
  }
  const closer = source.indexOf('\n---', 4);
  if (closer === -1) {
    throw new Error(`tsup.config.ts: SKILL.md at ${path} starts with frontmatter but has no closing '---'`);
  }
  const afterCloser = source.indexOf('\n', closer + 4);
  return (afterCloser === -1 ? '' : source.slice(afterCloser + 1)).trimStart();
}

const reactDevtoolsAlias = resolve(here, 'src/stubs/react-devtools-core.ts');
const BUNDLE_BANNER = [
  '#!/usr/bin/env node',
  "import { createRequire as __createRequire } from 'node:module';",
  'const require = __createRequire(import.meta.url);',
].join('\n');

export default defineConfig({
  banner: { js: BUNDLE_BANNER },
  clean: true,
  define: {
    __BOOTSTRAP_BODY__: JSON.stringify(bootstrapBody),
    __CLI_NAME__: JSON.stringify(manifest.name),
    __CLI_VERSION__: JSON.stringify(manifest.version),
    __SKILL_BODIES__: JSON.stringify(skillBodies),
  },
  esbuildOptions(options) {
    options.alias = {
      ...(options.alias ?? {}),
      'react-devtools-core': reactDevtoolsAlias,
    };
  },
  entry: { cli: 'src/cli.tsx' },
  external: ['update-notifier'],
  format: ['esm'],
  outDir: 'dist',
  platform: 'node',
  splitting: false,
  sourcemap: false,
  target: 'node22',
});
