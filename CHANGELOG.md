# Changelog

All notable changes to this project are documented in this file.

## [0.1.2] - 2026

### Fixed
- Works on dsh 0.2.1 (and keeps 0.1.x working): the host half no longer injects
  the removed `webRuntime` service (which left the whole entry pending, so
  `/temp-workspace/api/create` answered 405 from the static fallback). Request
  trust now defers to the host's own `connection.requestRejection` gate, which
  accepts loopback, the listener's bind address and declared trusted hosts.
- Session storage compatibility: `sessionPersistence.list()` snapshots
  (`{ header, location }`), `stat()`-based artifact locations and the
  per-generation `session.vN.jsonl[.zstd]` layout replace the removed
  `locate()`/`root` API, so cleanup, orphan sweeps and permanent-keep migration
  work again. Archived-id cleanup uses the public `unarchiveSession()`.
- Restart now works when the Web UI is reached through a LAN address: the guard
  uses the host gate plus a same-origin Origin instead of requiring a loopback
  socket.
- Browser half: New Session / folder picker use the 0.2.x `uiWorkspace` service
  (with the old `workspaces` face as fallback), and the settings card registers
  into the 0.2.x `settings.plugins.tab` slot (keeping the 0.1.x item slot).

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
