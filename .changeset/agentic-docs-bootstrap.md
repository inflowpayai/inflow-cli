---
'@inflowpayai/inflow': minor
---

Add `--bootstrap` and named-skill support to `--skill`, and project the web agent docs from the binary.

- `--bootstrap` prints the agent setup guide (install, authenticate, load a playbook) - the same text served at
  https://inflowcli.ai/skill.md.
- `--skill [name]` accepts an optional skill name (`--skill agentic-payments`, `--skill=agentic-payments`), defaulting
  to `agentic-payments`; unknown names exit 1 and list the available skills. Every `skills/<name>/SKILL.md` is embedded
  at build time.
- Both flags are listed in `--help` global options.
- `scripts/publish-skills.mjs` (wired into `build`/`release`) publishes the inflowcli.ai docroot from the binary:
  `skill.md` from `--bootstrap`, `llms.txt`/`llms-full.txt` from `--llms`/`--llms-full`, playbooks from
  `skills/*/SKILL.md`, and stamps the minimum Node version into the install scripts.
- The npm `homepage`, skill metadata, and command descriptions now reference https://inflowcli.ai; user-facing strings
  are ASCII-only.
