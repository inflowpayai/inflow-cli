#!/usr/bin/env node
/**
 * Publishes web-served skill files and stamps shared values into the install scripts. Destination: the inflowcli.ai
 * docroot in the sibling server repo — ../inflow-server/src/main/resources/static/cli/ (skipped silently when absent).
 *
 * 1. Skills/skill.md → <dest>/skill.md (entry point)
 * 2. Skills/<name>/SKILL.md → <dest>/skills/<name>.md (full playbooks; `allowed-tools` frontmatter stripped —
 *    host-execution directive, meaningless in web copies; all other frontmatter including `version:` preserved) Source
 *    of truth: skills/ for content, packages/cli/package.json for versions. Idempotent. Wired into the root `build` and
 *    `release` scripts after align-skill-version.js.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const skillsDir = resolve(repoRoot, 'skills');
const cliDist = resolve(repoRoot, 'packages/cli/dist/cli.js');
const dest = resolve(repoRoot, '../inflow-server/src/main/resources/static/cli');

const LLMS_HEADER = `# InFlow CLI

> Agent Enrollment Protocol access and MPP / x402 payments from your machine.
> Agent setup: https://inflowcli.ai/skill.md
> Enrollment playbook: https://inflowcli.ai/skills/agentic-enrollment.md
> Payments playbook: https://inflowcli.ai/skills/agentic-payments.md
> Source: https://github.com/inflowpayai/inflow-cli

`;

if (!existsSync(dest)) {
  process.stdout.write(`publish-skills: skipped (no ${dest})\n`);
  process.exit(0);
}

/** Remove the `allowed-tools` key (scalar, inline list, or block list) from YAML frontmatter. */
function stripAllowedTools(markdown) {
  const fm = markdown.match(/^---\n([\s\S]*?)\n---\n/);
  if (!fm) return markdown;
  const lines = fm[1].split('\n');
  const kept = [];
  let skippingBlock = false;
  for (const line of lines) {
    if (/^allowed-tools:/.test(line)) {
      skippingBlock = /^allowed-tools:\s*$/.test(line);
      continue;
    }
    if (skippingBlock) {
      if (/^\s+-/.test(line)) continue;
      skippingBlock = false;
    }
    kept.push(line);
  }
  return markdown.replace(fm[0], `---\n${kept.join('\n')}\n---\n`);
}

// 1: full playbooks, from source files (web copies keep `version:` frontmatter; --skill strips it)
const playbooks = readdirSync(skillsDir, { withFileTypes: true })
  .filter((e) => e.isDirectory() && existsSync(resolve(skillsDir, e.name, 'SKILL.md')))
  .map((e) => e.name);
mkdirSync(resolve(dest, 'skills'), { recursive: true });
for (const name of playbooks) {
  const body = readFileSync(resolve(skillsDir, name, 'SKILL.md'), 'utf8');
  writeFileSync(resolve(dest, 'skills', `${name}.md`), stripAllowedTools(body));
}
process.stdout.write(`publish-skills: [${playbooks.join(', ')}] → ${dest}/skills\n`);

// 1b: plugin payload — plugins/inflow/skills/ holds one symlink per installable skill (the loose
// skills/skill.md web entry is deliberately NOT exposed to plugin hosts). Ensure new skills propagate.
const pluginSkillsDir = resolve(repoRoot, 'plugins/inflow/skills');
if (existsSync(pluginSkillsDir)) {
  for (const name of playbooks) {
    const link = join(pluginSkillsDir, name);
    if (!existsSync(link)) {
      symlinkSync(join('..', '..', '..', 'skills', name), link);
      process.stdout.write(`publish-skills: plugin symlink created for skill '${name}'\n`);
    }
  }
}

// 2: binary-projected files — skill.md (--bootstrap), llms.txt (--llms), llms-full.txt (--llms-full)
if (existsSync(cliDist)) {
  const run = (flag) => {
    try {
      return execFileSync(process.execPath, [cliDist, flag], { encoding: 'utf8' });
    } catch (error) {
      process.stderr.write(`publish-skills: dist/cli.js failed on ${flag}\n`);
      throw error;
    }
  };
  writeFileSync(resolve(dest, 'skill.md'), run('--bootstrap'));
  writeFileSync(resolve(dest, 'llms.txt'), LLMS_HEADER + run('--llms'));
  writeFileSync(resolve(dest, 'llms-full.txt'), LLMS_HEADER + run('--llms-full'));
  process.stdout.write(`publish-skills: skill.md, llms.txt, llms-full.txt projected from ${cliDist}\n`);
} else {
  // Pre-build fallback: skill.md straight from source; llms files need the binary.
  writeFileSync(resolve(dest, 'skill.md'), readFileSync(resolve(skillsDir, 'skill.md'), 'utf8'));
  process.stdout.write(
    'publish-skills: no dist/cli.js — skill.md copied from source; llms.txt/llms-full.txt not generated\n',
  );
}
