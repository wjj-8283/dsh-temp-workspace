# Changelog

All notable changes to this project are documented in this file.

## [0.1.2] - 2026

### Changed
- The success dialog after a permanent keep **no longer offers a "Restart now"
  button** — the desktop app cannot restart its own host (killing the web host
  inside the Electron shell leaves the app broken), so the button only ever worked
  for the web deployment. The dismissible dialog now spells out the manual steps
  instead: web → quit the `dsh` process in the terminal and start it again;
  desktop → fully quit and reopen (Windows: tray icon → right-click → Exit;
  macOS: Command+Q, or right-click the Dock icon → Quit). The host keeps its
  `POST restart` endpoint, but nothing in the UI calls it any more.
- A **"Moving workspace…" notice** now covers the screen while a permanent keep is
  running: no progress bar, and it closes itself when the host answers (success
  dialog or "Action failed" follows). The move copies the folder and
  rewrites/relocates every session log, so quitting the Harness mid-flight is the
  one thing that could leave conversations half-migrated.
- The notice can no longer trap the user. It is a full-screen mask, so every way it
  could have outlived the request is now closed: it grows a **"Hide this notice"**
  button after 10 s (hiding never cancels the move), the request has a **90 s
  ceiling** after which the overlay is released and a dismissible dialog explains
  that the host has not reported back, and a React `unmount()` failure during close
  no longer leaves the overlay behind (it is caught and the node is removed
  anyway).

### Fixed
- A keep click could be **wired to the wrong workspace**, so it failed instantly
  with `Action failed` (an `ENOENT`/`scandir` against a directory that no longer
  existed). The button was paired with marker entries **by index** while rows follow
  the workspace registry order and the marker file follows creation order — and the
  marker also keeps **stale** entries whose folder was already deleted, shifting
  every later pairing by one. The row now supplies the identity:
  dsh 0.2.x stamps `data-row-key="workspace:<workspaceId>"` on the workspace row
  (session rows use `session:<id>`), so the button is bound to the workspace it is
  painted on, whatever the tree does. Host builds without the attribute fall back to
  the registry-ordered pairing.
- Entries whose directory is gone are reported as `missing` by `/list` and get **no
  keep button** (there is nothing to move), and a keep aimed at one now answers with
  a readable 409 ("the temporary workspace directory … no longer exists — its marker
  entry is stale and is cleaned up on the next Harness restart") instead of a bare
  `ENOENT`.
- The host now appends one line per stage of a keep to
  `~/.dsh/temp-workspaces/move-trace.log` (start → destination-ok →
  sessions-listed → contents-moved → registered → old-record-deleted → done). A
  keep whose browser request never returns — or fails immediately — can then be
  diagnosed from the file: the last line names the stage that wedged.

### Fixed
- **Permanent keep (pin) works again on dsh 0.2.x.** The browser half called
  `workspaces.pickDirectory()` / `workspaces.startSession()`, which 0.2.x moved
  off the `workspaces` data service onto the `uiWorkspace` UI service. Every call
  site now resolves `uiWorkspace` at click time with the data service as the
  fallback, so the pin button opens the folder picker instead of silently
  returning. A failed pick/move now shows a dialog ("Action failed", plus a
  localized reason) rather than doing nothing visible.
- The folder picker no longer goes through `ctx.remote.directoryPicker`. A
  namespaced remote needs its own `inject` entry, and cordis refused the read with
  `cannot get property "remote.directoryPicker" without inject` (surfaced as an
  "Action failed" dialog). The order is now: the desktop app's
  `globalThis.__DSH_DIRECTORY_PICKER__` bridge (dismiss → `null`, no inject), then
  `uiWorkspace.pickDirectory()` via the inject-free `ctx.get()`, then
  `workspaces.pickDirectory()` on 0.1.x. A desktop bridge that refuses (subframe
  call) falls back to the service picker instead of failing the action.
- **Conversation migration works on the 0.2.x session layout.** The log artifact
  is now `session.vN.jsonl.zstd` (one directory per session, one file per format
  generation), so the old hard-coded `session.jsonl.zstd` name matched nothing and
  a permanent keep moved the folder but migrated **zero** conversations. The move
  now matches every generation of the artifact family, carries each one over with
  its header `cwd` rewritten, and copies a log verbatim when its frame layout
  cannot be parsed (previously the fallback rewrote only frame 0 and dropped every
  event frame).
- `sessionPersistence.list()` snapshots nest their header under `snapshot.header`
  on 0.2.x; the session scans (workspace ownership, cold-session archiving) read
  the flat shape and silently found nothing. Both go through a snapshot-header
  helper now.
- The host half activates again on dsh 0.2.x. It injected `webRuntime`, a service
  0.2.x deleted, so the Loader entry stayed in the `pending` phase forever and
  **Settings → Plugins** reported it as "Waiting for dependencies" (no route, no
  boot cleanup, no icon click-through). The inject list is now
  `webServer` / `workspaceRegistry` / `sessionPersistence`, and the trusted
  non-loopback authority list is read from the web app's `webStartup` service
  (`trustedHosts`) when it exists — dsh 0.1.x's `webRuntime` is still accepted as
  a fallback, and without either the trust fence stays loopback-only.
- The settings UI is visible again on dsh 0.1.7. The old card registered into
  `settings.plugin.item`, a slot 0.1.7 removed, so `slots.inject` never fired and
  the settings silently disappeared. The page now registers into the shell's
  `settings.section` root list (id `dsh-temp-workspace`), the same seat the
  built-in General/Models/Plugins sections use.

### Changed
- Settings moved from a collapsible card under **Settings → Plugins** to a
  dedicated **Settings → Temporary workspace** page with its own navigation
  entry (heading + intro + one panel). The `/temp-workspace/api/config` contract
  (`deleteMode` / `deleteDelay` / `confirmBeforeDelete`) is unchanged, so
  existing profile-patch values keep working.

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

### Notes
- No runtime dependencies on official `@deepseek-ai/*` packages: the plugin
  receives services through the Cordis `ctx` injection, so nothing is
  duplicated inside the profile.

## [0.1.1] - 2026-09-25

### Fixed
- Works on dsh 0.1.7: the settings mechanism moved from the removed
  per-namespace `ctx.settings.register(ns, schema)` scope to the Loader entry's
  `Config` schema, and writes now go through
  `ctx.configEditor.edit(ctx.fiber.entry, …)`. The settings card keeps working
  unchanged (same `/temp-workspace/api/config` contract).
- Saving a setting no longer re-runs the boot cleanup: the boot pass and the
  confirmation-dialog state live at module scope, so a Loader config reload in
  the same process cannot re-arm the dialog or delete held workspaces.

### Changed
- Settings now live in the profile patch (entry `dsh-temp-workspace`'s `config`)
  instead of the removed `~/.dsh/settings.yaml`; export `Config` with the same
  defaults as before.
- `Config` needs `@deepseek-ai/schemastery` at module scope, so it is resolved
  from the dsh runtime root (`<DSH_HOME>/profiles/node_modules`) — see the
  comment in `lib/index.js`. That also makes `link:`-installed checkouts work.
