---
'@inflowpayai/inflow': patch
---

Fix the plugin bundle so the skill and MCP server actually load, and broaden host coverage.

- Add `skills`, `.mcp.json`, and `assets` symlinks under `plugins/inflow/` so the per-plugin manifests' `./skills/`,
  `./.mcp.json`, and `./assets/` paths resolve (previously they pointed at nonexistent paths and the skill/MCP server
  never loaded).
- Add a Cursor per-plugin manifest (`plugins/inflow/.cursor-plugin/plugin.json`), a Cursor marketplace entry
  (`.cursor-plugin/marketplace.json`), and an agents marketplace entry (`.agents/plugins/marketplace.json`).
- Stamp the repo-root `package.json` and the new Cursor per-plugin manifest from the version-sync script.
- Mention MPP alongside x402 in the Codex top-level manifest and Claude marketplace descriptions.
- Document agent/plugin install paths in the README.
