# Changelog

All notable changes to this project are documented in this file.

## [0.1.0] - 2026

### Added
- Temporary workspace for DSH web: a one-click throwaway workspace whose
  conversations are deleted at the next Harness restart (immediately or after a
  delay, optionally behind a confirm dialog).
- Pin a temp workspace to keep it permanently: files move into the folder you
  pick, the folder name becomes the workspace title, and its conversations are
  migrated (followed by a real host-level restart to re-index).
- Settings → Plugins card (`dsh-temp-workspace`) with `deleteMode`,
  `deleteDelay` and `confirmBeforeDelete`.
- npm prebuilt install (`@wjj-8283/dsh-temp-workspace`) so users get a
  one-command install that skips the `allowBuilds` build-approval step.

### Changed
- `build.mjs` gained a `--check` mode to keep the committed prebuilt
  `lib/client.js` in sync with `src/client.js`.

### Fixed
- Works on dsh 0.1.7: the settings mechanism moved from the removed
  per-namespace `ctx.settings.register(ns, schema)` scope to the Loader entry's
  `Config` schema, and writes now go through
  `ctx.configEditor.edit(ctx.fiber.entry, …)`.
- Saving a setting no longer re-runs the boot cleanup: the boot pass and the
  confirmation-dialog state live at module scope, so a Loader config reload in
  the same process cannot re-arm the dialog or delete held workspaces.

### Notes
- No runtime dependencies on official `@deepseek-ai/*` packages: the plugin
  receives services through the Cordis `ctx` injection, so nothing is
  duplicated inside the profile. `Config` does need `@deepseek-ai/schemastery`
  at module scope, so it is resolved from the dsh runtime root
  (`<DSH_HOME>/profiles/node_modules`) — see the comment in `lib/index.js`.
