# @dsh-dev/dsh-temp-workspace

A DSH web **client plugin** that adds a **temporary workspace**.

> [中文说明](README.zh.md)

Click the small hourglass icon beside the sidebar's "Add workspace" (+) button
to create a throwaway workspace and open a fresh conversation in it. On the
next Harness restart this plugin **deletes the conversations** under that
workspace **and the workspace itself** — the temp workspace leaves no trace.

## What it is

- **Host half** (`lib/index.js`) — a Cordis plugin that injects
  `webServer` / `webRuntime` / `workspaceRegistry` / `sessionPersistence`,
  `settings` and `loader`, registers a browser-trust-fenced
  `/temp-workspace/api` route, and drives the cleanup at boot.
- **Browser half** (`src/client.js` → `lib/client.js`) — injects a small icon
  button beside the sidebar "+ Add workspace" button; on click it calls the
  host route and opens a new Conversation in the created workspace. It also
  registers a **Settings → Plugins** card and, when the setting is enabled, a
  confirm dialog at boot.

## Installation

### From npm (prebuilt — recommended)

The package is published to npm with `lib/` **prebuilt**, so installing it
needs no build and skips pnpm's `allowBuilds` approval — a single command:

```sh
dsh plugin --profile web add @dsh-dev/dsh-temp-workspace
```

`dsh plugin … add` forwards the spec to pnpm inside the profile dir, then
reconciles `dsh.profile.bundles` for you. Because the manifest declares
`dsh.bundle.patch`, the package auto-joins the Loader layer stack, so on the
next `dsh web` start the host composes the plugin as a Loader entry, registers
the `/temp-workspace/api` route, and the settings card enters `__DSH_BOOT__`.

To republish after a change (requires an npm account that owns the
`@dsh-dev` scope):

```sh
npm login                # one-time
npm publish               # prepublishOnly rebuilds lib/client.js from src
```

### From GitHub

Install it straight from GitHub with the `dsh plugin` forwarder (pnpm clone +
`add` inside the profile dir, then the bundle layer is reconciled for you):

```sh
# boot a profile, e.g. the web app
dsh plugin --profile web add github:wjj-8283/dsh-temp-workspace
```

Because the manifest declares `dsh.bundle.patch`, the add step auto-appends
the package to `dsh.profile.bundles`, so on the next `dsh web` start the host
composes the plugin as a Loader entry, registers the `/temp-workspace/api`
route, and the settings card enters `__DSH_BOOT__`.

If you prefer to drive pnpm yourself, run the same spec from inside the profile
directory:

```sh
cd "$DSH_HOME/profiles/web"
pnpm add github:wjj-8283/dsh-temp-workspace
```

To pin a branch, tag or commit, append the usual pnpm git ref:

```sh
dsh plugin --profile web add github:wjj-8283/dsh-temp-workspace#<ref>
```

> The built client bundle (`lib/client.js`) is committed in the repo, so a git
> install runs no build step. To hack on it, clone the repo and use
> `node build.mjs --watch` (see [Dev loop](#dev-loop)) — or install from a local
> checkout instead (see [Wiring into the profile](#wiring-into-the-profile)).

## Settings → Plugins

The plugin registers a card in **Settings → Plugins** (keyed by the settings
namespace `dsh-temp-workspace`, persisted in `~/.dsh/settings.yaml`):

| setting | values | default | meaning |
| --- | --- | --- | --- |
| `deleteMode` | `immediate` / `delayed` | `immediate` | when a temp workspace is removed on the next boot |
| `deleteDelay` | seconds | `3600` | grace period before removal when `delayed` |
| `confirmBeforeDelete` | on / off | `on` | ask the user before removing held workspaces |

- `confirmBeforeDelete` **on**: the host never auto-deletes at boot. It holds the
  workspaces and the browser shows a **confirm dialog** with two choices:
  - **Delete** — purge the held workspaces (sessions + registration + dir).
  - **Keep temporarily** — leave the workspaces alone this boot but
    keep them **temporary**: they stay in the marker and are subject to cleanup
    (and re-confirmation) again on a later boot.
  - An unanswered dialog leaves the workspaces intact for the next boot.

**Permanent keep** is not in the boot dialog — it has its own button.
Each temp workspace row in the sidebar (titled "临时工作区", i.e. "Temporary Workspace") shows a small **pin**
button next to its "＋" (New Session). Clicking it picks a destination folder (the
OS folder picker via `ctx.workspaces.pickDirectory()`). The temp workspace's files
are moved **directly into that folder** (no extra "临时工作区" subfolder is
created), the folder itself becomes the permanent workspace, and its **folder name
is used as the workspace title**. The workspace's **conversations are migrated
too**: each session log's header `cwd` is rewritten to the folder path and its log
directory is moved into the new cwd's projectKey slot. After it succeeds, a
**non-dismissible** dialog appears with a **"Restart now"** button that
triggers a **real host-level restart** (a detached helper respawns the exact DSH
invocation — the same mechanism `dsh-market` uses for plugin updates) so the
registry re-indexes and the migrated conversations appear under the new workspace.
- `confirmBeforeDelete` **off**: deletion is automatic — immediately on boot, or
  after `deleteDelay` seconds when `deleteMode` is `delayed`.

## How cleanup works

There is **no public "delete session log" API** in DSH — the persistence seam is
append-only. So a temporary workspace is removed in four steps:

0. **Live sessions first** — sessions the running host still holds in memory
   (a confirm dialog, the delayed auto-delete, or a page reload can all trigger
   the deletion in a host that never truly restarted) are torn down best-effort:
   their agent is cancelled and awaited idle, the session's pending writes are
   flushed to disk, and the live store entry is detached so `session.list` drops
   it and the client closes the conversation immediately. Flushing **before**
   detaching keeps multi-session workspaces clean: detaching emits
   `session/disposed`, whose retirement flush would otherwise re-materialize a
   deleted log for sessions that still had pending writes, leaving unreadable
   Ungrouped leftovers.
0b. **Archive cold sessions** — sessions that were never attached in this host
   exist only as disk logs; deleting those logs sends no `session-removed`
   event, so an already-open browser would keep them as unreadable Ungrouped
   leftovers. `archiveColdSessions` archives each of them (the supported
   "hidden from every grouping surface" mechanism) BEFORE the logs are deleted:
   the archive-set change pushes `host/archived-sessions-changed` and the
   sidebar drops them at once. The durable archived-id entries are reclaimed by
   the boot-time orphan sweep.
1. **Sessions on disk** — every session owned by the workspace (its header `cwd`
   equals the workspace path) is located through `ctx.sessionPersistence.locate`
   and its on-disk directory is removed with `fs.rm`.
2. **Registration** — `ctx.workspaceRegistry.delete(id)` removes the workspace
   record (which never touches logs or the directory by itself).
3. **Directory** — the throwaway directory (under
   `<dsh-home>/temp-workspaces/<uuid>`) is removed.

The plugin tracks temporary workspaces in `<dsh-home>/temp-workspaces/state.json`
(a durable marker of `{ workspaceId, path, createdAt }`). Deletion is driven by
that marker path, so a temp workspace whose **registry record was already removed
via the UI before a restart** still reaps its leftover directory (the fix for the
"leftover folder" bug) — the marker path, not the registry record, is the source of
truth for the directory.

**No trace**: deletion also prunes each detached live session's
**projection-cache row** (the `session_projcache` domain under
`~/.dsh/storages/session_projcache.json`) and the legacy per-session cache file
from an older storage layout. A boot-time **orphan sweep**
(`pruneOrphanTempResidue`) additionally reclaims every projection-cache row
whose `cwd` lives under the temp root and is no longer referenced by the
marker — together with its archived-id record (the ones `archiveColdSessions`
and the detach fallback leave behind) and legacy cache file. Those rows never
surface ghost conversations by themselves (identity-checked reads miss them),
but "no trace" means no trace; the user's intentional archives of real
conversations are never touched.

## Layout

```
temp-workspace-plugin/
  package.json       name, dsh.bundle.patch + dsh.client, exports
  cordis.patch.yml   inserts this plugin as a host Loader entry
  lib/index.js       node half — /temp-workspace/api route + settings + boot cleanup
  src/client.js      browser half SOURCE (icon + settings card + confirm dialog)
  lib/client.js      BUILT browser half (generated; do not edit)
  build.mjs          wrap src/client.js -> lib/client.js (HMR watch)
```

## Dev loop

```sh
node build.mjs --watch
```

`lib/client.js` is the single file client-modules serves and dsh-client-hmr
polls; editing `src/client.js` hot-reloads the UI without a page refresh.
**Host-half changes** (`lib/index.js`) need a `dsh web` restart.

## Wiring into the profile

```sh
# local checkout / clone (any absolute or relative path)
dsh plugin --profile web add /path/to/dsh-temp-workspace
```

This adds it to `dsh.profile.bundles`. On the next `dsh web` start the host
composes the row, the `/temp-workspace/api` route is registered, the settings
card enters `__DSH_BOOT__`, and the boot cleanup / confirm flow runs.

## API (`/temp-workspace/api/<method>`)

Reads accept `GET`, mutations `POST`.

| method | returns | notes |
| --- | --- | --- |
| `POST create` | `{ workspace, created: true }` | mkdir + `workspaceRegistry.create` + marker |
| `GET list` | `{ entries }` | `[{ workspaceId, path, createdAt }]` currently marked temporary |
| `POST delete` | `{ ok: true }` | remove one temp workspace now (sessions + registration + dir) |
| `GET/POST config` | `{ ok, value }` | read the settings, or `POST {…}` to write a patch |
| `POST configReset` | `{ ok, value }` | restore every setting to its default |
| `GET pending` | `{ ok, value }` | held workspaces + `confirmBeforeDelete` + `deleteAt` |
| `POST confirm` | `{ ok, deleted }` | user confirmed — delete the held set |
| `POST keep` | `{ ok, kept }` | temporary keep — leave the held set alone (still temp) |
| `POST permanentKeep` | `{ ok, moved }` | `{ target, workspaceId? }` — use `target` (picked folder) directly and de-temp that workspace (or all held when `workspaceId` omitted) |
| `POST restart` | `{ restarting, pid, helperPid }` | real host restart (same-origin loopback only) |

## Notes / limits

- The sidebar workspace browser has **no slot** for a header action, so the
  icon is injected into the DOM with a `MutationObserver` (same idiom as
  `dsh-workspace-auto-approval`). If the sidebar layout changes upstream the
  icon may need a matching placement update.
- The add-workspace button only renders when the directory-flow hole is
  occupied, so the temp-workspace icon appears only then too.
- Cleaning removes session log directories directly. **Live** sessions owned by
  a temp workspace are torn down best-effort on delete (agent cancel + archive +
  live-store detach), so the conversations disappear even when the deletion runs
  in a host that still holds them in memory; at boot there are no live sessions,
  which is exactly when cleanup runs.
- A temp workspace's directory lives under the DSH home (`~/.dsh/temp-workspaces`),
  not in your normal project folders.
- There is no generic "ask the human" API for a browser plugin, so the confirm
  dialog is rendered by the plugin itself as a lightweight inline-styled overlay
  through its own `react-dom/client` root (no dependency on the primitives'
  CSS-module scope, so it always shows).
- **Permanent Keep** requires the `native` directory-picker capability
  (`ctx.workspaces.pickDirectory()`); on a remote/non-native deployment that
  picker is unavailable and the button is disabled.
- Conversation migration rewrites only the **header frame** of each session log
  (a `.jsonl.zstd` file is a concatenation of independently-compressed
  Zstandard frames — frame 0 is the header line carrying `cwd`, the rest are
  the event batches). The header frame's `cwd` is rewritten and every event
  frame is preserved byte-for-byte, so no conversation content is lost.
- A `cwd` is immutable in the DSH session header, hence the rewrite approach.
  The DSH workspace registry's session→workspace **grouping (`bootstrap`) only
  runs once on the first boot**; later boots only rebuild the id→cwd index and
  never add a migrated session to the new workspace's `sessionIds`. To avoid the
  migrated conversations ending up **ungrouped**, the plugin records a durable
  **pending-attach** list during the move and, on the next boot, re-attaches the
  migrated sessions to the new workspace — which is why the client prompts a
  restart after a permanent keep.

## Known bugs that we will not fix

- Due to Harness limits, after a permanent keep there is a chance the conversation
  ends up `Ungrouped`. We have done what we can to handle it, but it can still
  occur.
- After creating a temp workspace, the permanent-keep button may not appear
  immediately; it will show up after a short while (2–3 s). Not planning to fix.
- Due to Harness limits, right after a migration the conversation name may take
  the workspace's name; clicking it changes it back. It does not affect use; not
  planning to fix — rename it yourself might help.