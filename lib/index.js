// @dsh-dev/dsh-temp-workspace — node half.
//
// Adds a "temporary workspace" (临时工作区) feature to the DeepSeek Harness web
// UI. A temporary workspace is an ordinary registry Workspace over a throwaway
// directory; every Session it owns is also temporary. On the next Harness
// start this plugin deletes those conversations (their session logs on disk)
// AND the workspace record itself, leaving no trace.
//
// Two halves:
//   - Host half (this file): registers a browser-trust-fenced /temp-workspace/api
//     route (create/delete/list + the settings config/pending/confirm/keep
//     surfacing) and, at boot, cleans up the workspaces recorded as temporary.
//   - Browser half (./client.js): injects a small icon button beside the
//     sidebar's "Add workspace" (+) button. Clicking it asks this route to
//     create a temporary workspace and opens a new Session in it. It also
//     renders a Settings -> Plugins card and, when confirmBeforeDelete is on,
//     a popup on boot before removing held workspaces.
//
// There is no public "delete session log" API in DSH (the persistence seam is
// append-only), so cleanup deletes the session directories on disk directly
// (computed through ctx.sessionPersistence.locate) before removing the
// workspace registration (workspaceRegistry.delete). Deleting a workspace
// registration retains the directory and session logs, so this plugin removes
// both explicitly. Deletion is driven by a durable marker (path + id) so a
// workspace whose registry record was already removed via the UI before a
// restart still reaps its leftover directory.

import { mkdir, readFile, writeFile, rename, rm, cp, stat, readdir } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, dirname, resolve, isAbsolute } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { promisify } from 'node:util'
import { zstdCompress, zstdDecompress } from 'node:zlib'

const zstdCompressAsync = promisify(zstdCompress)
const zstdDecompressAsync = promisify(zstdDecompress)

const PLUGIN_ID = 'dsh-temp-workspace'
const TEMP_TITLE = '临时工作区'
const SETTINGS_NS = 'dsh-temp-workspace'
// Default behavior when the user has not configured anything: delete on the
// next boot immediately, but confirm with the user before doing so.
const DEFAULT_SETTINGS = Object.freeze({
  deleteMode: 'immediate', // 'immediate' | 'delayed'
  deleteDelay: 3600,       // seconds to wait after boot when deleteMode === 'delayed'
  confirmBeforeDelete: true,
})
// A marker file under the DSH home listing every workspace currently marked
// temporary. Keep it next to the throwaway workspace dirs so a single recursive
// removal of the root dir never nukes the marker while a workspace exists.
const root = () => join(dshHome(), 'temp-workspaces')
const statePath = () => join(root(), 'state.json')

// The original (unwrapped) workspace registry `delete` method, captured in
// `apply`. The plugin's own cleanup path calls this so it never re-enters the
// temp-cleanup hook, while external (native sidebar) deletes go through the
// wrapped version that reaps the temp workspace's files first.
let registryDeleteUnwrapped = null

/** The DSH home: $DSH_HOME, else ~/.dsh (mirror of @deepseek-ai/dsh-home-paths). */
function dshHome() {
  const env = process.env.DSH_HOME
  if (typeof env === 'string' && env.trim() !== '') return env.trim()
  return join(homedir(), '.dsh')
}

/**
 * Mirror of the JSONL persistence store's `projectKey(cwd)` (kept in
 * @deepseek-ai/dsh-session-persistence-jsonl). Returns the single filesystem-safe
 * project directory name for a workspace cwd, e.g. a temp workspace at
 * `/Users/wjj/.dsh/temp-workspaces/<uuid>` becoming
 * `--Users-wjj-.dsh-temp-workspaces-<uuid>--`. Replicating the exact encoding
 * is what lets us identify the session project dirs a temp workspace owns.
 */
function projectKey(cwd) {
  if (typeof cwd !== 'string' || cwd.length === 0) return '_no-cwd'
  let readable = ''
  let separatorRun = false
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += '~' + code.toString(16).toUpperCase().padStart(4, '0')
      separatorRun = false
    }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`
}

/** The session project directory name that `cwd`'s sessions live under. */
function projectDirName(cwd) {
  return projectKey(cwd)
}

/**
 * Remove a session project directory once it holds nothing but junk (a leftover
 * `.DS_Store`) — i.e. after every real session dir inside it is gone. This is
 * what prevents the empty `--<cwd>--` directories from accumulating after a
 * temp workspace's logs are cleaned or migrated. Only fires when there is no
 * session content left, so it can never drop a live conversation.
 */
async function pruneEmptyProjectDir(projectDir) {
  try {
    const entries = await readdir(projectDir)
    if (entries.length === 0) {
      await rm(projectDir, { recursive: true, force: true }).catch(() => {})
      return
    }
    // macOS Finder often leaves a stray .DS_Store; treat that alone as empty.
    if (entries.every((name) => name === '.DS_Store')) {
      await rm(projectDir, { recursive: true, force: true }).catch(() => {})
    }
  } catch { /* already absent */ }
}

// ── durable marker state ────────────────────────────────────────────────────
/** Read the temp-workspace marker list (missing/corrupt file => []). */
async function readState() {
  try {
    const raw = await readFile(statePath(), 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed && Array.isArray(parsed.tempWorkspaces)) return parsed.tempWorkspaces
  } catch { /* first boot / absent / corrupt — start empty */ }
  return []
}

/** Atomically persist the temp-workspace marker list. */
async function writeState(list) {
  const dir = dirname(statePath())
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const tmp = `${statePath()}.tmp`
  await writeFile(tmp, JSON.stringify({ tempWorkspaces: list }, null, 2), { mode: 0o600 })
  await rename(tmp, statePath())
}

// ── pending session re-attach (survives the restart the client prompts) ─────
// The registry's session→workspace grouping (bootstrap) runs only once on the
// first boot. Migrated sessions are moved + their cwd rewritten on disk, but the
// already-initialized registry never adds them to the new workspace's sessionIds.
// So we persist a "pending attach" list and re-attach on the next boot, when
// `replaceHeaderIndex` has indexed the migrated headers with the fresh cwd.
const pendingAttachPath = () => join(root(), 'pending-attach.json')

/** Read pending session-attach jobs (missing/corrupt file => []). */
async function readPendingAttach() {
  try {
    const raw = await readFile(pendingAttachPath(), 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed && Array.isArray(parsed.jobs)) return parsed.jobs
  } catch { /* first boot / absent / corrupt */ }
  return []
}

/** Atomically persist the pending session-attach jobs. */
async function writePendingAttach(jobs) {
  const dir = dirname(pendingAttachPath())
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const tmp = `${pendingAttachPath()}.tmp`
  await writeFile(tmp, JSON.stringify({ jobs }, null, 2), { mode: 0o600 })
  await rename(tmp, pendingAttachPath())
}

/** Append one pending-attach job (workspaceId + migrated session ids). */
async function addPendingAttach(workspaceId, path, sessionIds) {
  if (sessionIds.length === 0) return
  const jobs = await readPendingAttach()
  jobs.push({ workspaceId, path, sessionIds, at: new Date().toISOString() })
  await writePendingAttach(jobs)
}

/**
 * Re-attach every persisted migrated session to its new workspace. Returns the
 * number of sessions attached; clears the pending list even for jobs that could
 * not be resolved (so a stale record never blocks later ones).
 */
async function reattachPendingSessions(ctx) {
  const jobs = await readPendingAttach()
  if (jobs.length === 0) return 0
  let attached = 0
  for (const job of jobs) {
    if (job === null || typeof job !== 'object' || !Array.isArray(job.sessionIds)) continue
    const ws = ctx.workspaceRegistry.get(job.workspaceId)
    if (ws === undefined) {
      console.warn(`[${PLUGIN_ID}] pending re-attach: workspace ${job.workspaceId} no longer exists; dropping`)
      continue
    }
    for (const sessionId of job.sessionIds) {
      if (typeof sessionId !== 'string') continue
      try {
        await ws.attachSession(sessionId)
        attached += 1
      } catch (error) {
        console.error(`[${PLUGIN_ID}] re-attach ${sessionId} failed`, error)
      }
    }
  }
  await writePendingAttach([])
  return attached
}

// ── workspace helpers ───────────────────────────────────────────────────────
/** Project a registry Workspace into the wire WorkspaceView shape. */
function toView(ws) {
  return {
    workspaceId: ws.id,
    path: ws.path,
    title: ws.title,
    sessionIds: [...ws.sessionIds],
    createdAt: ws.createdAt,
    updatedAt: ws.updatedAt,
  }
}

/** Remove from disk every session log living under `cwd` (the temp workspace dir). */
async function deleteSessionsUnderPath(ctx, cwd) {
  // Remove the whole cwd project directory rather than matching individual
  // headers. The JSONL store groups a workspace's session logs under
  // `<sessionsRoot>/--<projectKey(cwd)>--`, so deleting that directory clears
  // every conversation for this temp workspace regardless of header state (a
  // blank session may not be materialized as a header yet, and a stale header
  // cache could otherwise make the cwd match miss a live log). Because the temp
  // workspace's throwaway dir is unique (under ~/.dsh/temp-workspaces/<uuid>),
  // its projectKey can never collide with a real workspace's project dir.
  let sessionsRoot
  try { sessionsRoot = ctx.sessionPersistence.root } catch { return }
  if (typeof sessionsRoot !== 'string' || sessionsRoot === '') return
  const projectDir = join(sessionsRoot, projectKey(cwd))
  await rm(projectDir, { recursive: true, force: true }).catch(() => {})
}

/** Remove from disk every session log a workspace record still claims. */
async function deleteWorkspaceSessions(ctx, ws) {
  // Same project-dir strategy as deleteSessionsUnderPath: this workspace's logs
  // all live under its cwd's project directory, so remove it wholesale (more
  // robust than matching headers by id, which misses blank/unmaterialized ones).
  await deleteSessionsUnderPath(ctx, ws.path)
}

/**
 * Best-effort removal of LIVE sessions owned by a temp workspace, so a delete
 * that runs while the host still holds those sessions actually drops the
 * conversations from the UI — not just from disk. This is the gap behind the
 * "cleared the temp workspace but the conversations are still there" bug:
 * the boot confirm dialog / delayed auto-delete / sidebar delete can all run
 * in a host process that never truly restarted (a page reload keeps the host
 * and its in-memory sessions alive), and DSH's own workspace delete only
 * removes the registration.
 *
 * Order matters for workspaces with MORE THAN ONE live session. The detach
 * below emits `session/disposed`, and the persistence coordinator answers
 * that with a retirement flush (`retire` → `flush` → `initFor`), which
 * MATERIALIZES the session's log file when it is not on disk yet. If that
 * flush races the directory deletion (the caller removes the project dir
 * right after this, and a late flush re-materializes a log in its place),
 * the conversations turn into unreadable Ungrouped leftovers. So before
 * detaching we:
 *   1. cancel the agent and wait for the aborted turn to settle
 *      (`whenIdle`, mirroring the agent loop's own dispose: the cancelled
 *      turn appends `turn/end` before going idle);
 *   2. flush the session (`sessions.flush`) so every pending write — the
 *      materialized header included — is durably on disk NOW;
 * then detach, whose retirement flush has nothing left to write and cannot
 * re-create the log after the directory is removed.
 *
 * After the detach we also prune the session's projection-cache row (the
 * detach checkpoints one last time, so the prune retries briefly) and the
 * legacy per-session cache file — the "no trace" half of this function; the
 * boot-time orphan sweep is the authoritative net for anything that slips
 * through.
 *
 * Every step is optional and fail-soft:
 *   - the live-store detach (the primary removal) emits `session/disposed`
 *     so the client drops the conversation at once;
 *   - only when that internal detach is unavailable do we fall back to
 *     `archiveSession`, the registry's supported "hidden from every grouping
 *     surface" mechanism (the sidebar groups, flat list, and search all
 *     filter archived ids) — the conversation disappears anyway, at the
 *     cost of a durable archived-id entry the orphan sweep later reclaims.
 * @returns the number of live sessions removed.
 */
async function removeLiveSessions(ctx, cwd) {
  if (typeof cwd !== 'string' || cwd === '') return 0
  const sessions = (typeof ctx.get === 'function' && ctx.get('sessions')) || ctx.sessions
  const agents = (typeof ctx.get === 'function' && ctx.get('agents')) || ctx.agents
  if (!sessions || typeof sessions.list !== 'function') return 0
  const owned = []
  for (const session of sessions.list()) {
    if (session && typeof session === 'object' && session.header && session.header.cwd === cwd) owned.push(session)
  }
  let removed = 0
  const detachedIds = []
  for (const session of owned) {
    try {
      const id = session.id
      // 1. Stop any running turn and wait for it to settle, so its final
      //    `turn/end` append lands before we flush (no log resurrection).
      try {
        const agent = agents && typeof agents.get === 'function' ? agents.get(id) : undefined
        if (agent && typeof agent.cancel === 'function') {
          agent.cancel({ kind: 'disposed' })
          if (typeof agent.whenIdle === 'function') {
            await Promise.race([agent.whenIdle(), settleTimeout(2000)])
          }
        }
      } catch (error) {
        console.error(`[${PLUGIN_ID}] cancel live agent ${id} failed`, error)
      }
      // 2. Drain every pending write to disk NOW, so the retirement flush
      //    triggered by the detach below has nothing to write and cannot
      //    re-materialize the log after the directory is deleted.
      try {
        if (typeof sessions.flush === 'function') await sessions.flush(session)
      } catch { /* best-effort */ }
      // 3. Detach — the primary removal (emits session/disposed).
      let detached = false
      try {
        const store = sessions.store
        const entry = store && typeof store.get === 'function' ? store.get(id) : undefined
        if (entry !== undefined && typeof sessions.detachEntered === 'function') {
          sessions.detachEntered(entry)
          detached = true
          removed += 1
          detachedIds.push(id)
        }
      } catch { /* fall through to the archive fallback */ }
      // 4. Fallback when the live-store detach is unavailable: archive, so
      //    the conversation is hidden from every grouping surface anyway.
      if (!detached) {
        try {
          if (ctx.workspaceRegistry && typeof ctx.workspaceRegistry.archiveSession === 'function') {
            await ctx.workspaceRegistry.archiveSession(id)
          }
        } catch { /* best-effort */ }
      }
    } catch (error) {
      console.error(`[${PLUGIN_ID}] live-session cleanup failed for ${session?.id}`, error)
    }
  }
  // Let the detach-induced retirement flushes and projection-cache detach
  // checkpoints settle on the microtask queue so the caller's directory
  // deletion never races a late write.
  await settleTimeout(0)
  // Prune the durable projection-cache rows. The detach checkpoints the
  // session one last time (flushSoft on session/disposed), so retry briefly
  // until the row stays gone; the boot-time orphan sweep is the net.
  for (const id of detachedIds) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await settleTimeout(80)
      await pruneSessionResidue(ctx, id)
    }
  }
  return removed
}

/** A promise that resolves after `ms`, never rejects — for bounded best-effort waits. */
function settleTimeout(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** The legacy per-session projection-cache file path for one session id (older storage layout). */
function legacyProjectionCacheFile(id) {
  return join(dshHome(), 'storages', 'session_projcache', 'sessions', `${id}.json`)
}

/** Remove one session's durable projection-cache residue (row + legacy file), fail-soft. */
async function pruneSessionResidue(ctx, id) {
  if (typeof id !== 'string' || id === '') return
  try {
    const cache = (typeof ctx.get === 'function' && ctx.get('sessionProjectionCache')) || ctx.sessionProjectionCache
    if (cache && cache.table && typeof cache.table.delete === 'function') {
      await cache.table.delete(id)
    }
  } catch { /* best-effort */ }
  await rm(legacyProjectionCacheFile(id), { force: true }).catch(() => {})
}

/**
 * Hide the COLD (persisted-but-not-attached) sessions of a temp workspace from
 * every grouping surface by archiving them. Deleting their logs alone leaves
 * a stale entry in an already-open browser: cold sessions are not in the live
 * session store, so the detach in `removeLiveSessions` cannot emit the
 * `session/disposed` → `host/session-removed` event that would drop them —
 * they linger in the sidebar as unreadable Ungrouped conversations until a
 * reload. Archiving is the supported counterpart: the archive-set change
 * pushes `host/archived-sessions-changed`, and the sidebar (groups, flat
 * list, and search) filters archived ids, so the stale entries disappear
 * immediately. The durable archived-id entry is reclaimed by the boot-time
 * orphan sweep (`pruneOrphanTempResidue`), which finds the session's
 * projection-cache row.
 *
 * Runs BEFORE the logs are deleted (the session catalog is read from disk).
 * @returns the number of sessions archived.
 */
async function archiveColdSessions(ctx, cwd) {
  if (typeof cwd !== 'string' || cwd === '') return 0
  const sessions = (typeof ctx.get === 'function' && ctx.get('sessions')) || ctx.sessions
  const live = new Set()
  if (sessions && typeof sessions.list === 'function') {
    for (const session of sessions.list()) {
      if (session && session.header && session.header.cwd === cwd) live.add(session.id)
    }
  }
  let archived = 0
  let headers
  try { headers = await ctx.sessionPersistence.list() } catch { return 0 }
  for (const meta of headers) {
    if (meta.cwd !== cwd) continue
    if (live.has(meta.id)) continue // live sessions are detached, not archived
    try {
      if (ctx.workspaceRegistry && typeof ctx.workspaceRegistry.archiveSession === 'function') {
        await ctx.workspaceRegistry.archiveSession(meta.id)
        archived += 1
      }
    } catch { /* best-effort */ }
  }
  return archived
}

/**
 * Remove a temp workspace's on-disk footprints WITHOUT touching the workspace
 * registry: its session logs under its cwd project dir, its throwaway dir, and
 * its marker entry. This is the file-reaping half shared by `deleteTempWorkspace`
 * and by the registry-delete hook (which runs when a temp workspace is removed
 * via the native sidebar delete — DSH's own registry delete retains the
 * directory and every session log, so without this the conversations would
 * survive). Safe to call for an already-unregistered temp workspace.
 */
async function reapTempWorkspaceFiles(ctx, entry) {
  const { workspaceId, path } = entry ?? {}
  if (typeof path === 'string' && path !== '') {
    await removeLiveSessions(ctx, path)
    await archiveColdSessions(ctx, path)
    await deleteSessionsUnderPath(ctx, path)
    await rm(path, { recursive: true, force: true }).catch(() => {})
  }
  if (typeof workspaceId === 'string' && workspaceId !== '') {
    const list = (await readState()).filter((item) => item.workspaceId !== workspaceId)
    await writeState(list)
  }
}

/**
 * Delete one temporary workspace. `entry` comes from the marker and carries the
 * recorded `path`, which is the single source of truth for the throwaway dir —
 * deleting it must NOT depend on the registry record still existing. When a
 * user removes the temp workspace via the UI before restart, the registry
 * record is already gone but the folder (and any sessions it owned) remain;
 * this path-driven deletion is what reaps that leftover.
 */
async function deleteTempWorkspace(ctx, entry) {
  const { workspaceId, path } = entry
  const ws = ctx.workspaceRegistry.get(workspaceId)
  if (ws !== undefined) {
    // Tear down live sessions first: a running agent must be stopped before
    // its log directory is removed, or it would re-materialize the log and
    // the conversation would survive the delete. Then archive the cold
    // (unattached) sessions so an already-open browser drops them too.
    await removeLiveSessions(ctx, ws.path)
    await archiveColdSessions(ctx, ws.path)
    await deleteWorkspaceSessions(ctx, ws)
    // Use the unwrapped delete so the temp-cleanup hook does not re-enter.
    const del = registryDeleteUnwrapped ?? ctx.workspaceRegistry.delete.bind(ctx.workspaceRegistry)
    await del(workspaceId)
  }
  await reapTempWorkspaceFiles(ctx, { workspaceId, path: path || ws?.path })
}

/**
 * Permanently keep a temp workspace: move its files INTO a user-chosen folder
 * (used directly — no extra subfolder is created) and re-register that folder as
 * an ordinary (permanent) workspace named after the folder. This de-temps the
 * workspace — it is no longer in the temp marker and so is never auto-deleted.
 *
 * The workspace's conversations are migrated too: each session log's header
 * frame `cwd` is rewritten to the folder path and its log directory is moved
 * into the new cwd's projectKey slot. Session logs are zstd-compressed, so only
 * the independent header frame is rewritten; the event frames are preserved
 * byte-for-byte. The session is not attached in-session (the registry caches
 * headers from boot); it re-attaches on the next restart, which the client
 * prompts for.
 *
 * @returns the new permanent workspace view.
 */
async function moveTempWorkspace(ctx, entry, targetDir) {
  const { workspaceId, path: sourcePath } = entry
  const ws = ctx.workspaceRegistry.get(workspaceId)
  const from = sourcePath || ws?.path || ''
  if (from === '') throw new TempWorkspaceError('bad-path', 'no source directory recorded for this temp workspace', 400)
  const target = resolve(targetDir)
  if (target === from) throw new TempWorkspaceError('bad-path', 'source and destination are the same directory', 400)
  // The user-chosen folder becomes the workspace, so its name is the title.
  const title = describeTitle(target)

  // Validate the destination: it must be an existing directory, and not already
  // owned by a workspace (we never merge into an existing workspace's folder).
  let targetStat
  try { targetStat = await stat(target) } catch { targetStat = undefined }
  if (targetStat === undefined || !targetStat.isDirectory()) {
    throw new TempWorkspaceError('bad-path', `destination folder "${target}" is not an existing directory`, 400)
  }
  const existing = await ctx.workspaceRegistry.resolveByPath(target).catch(() => undefined)
  if (existing !== undefined) {
    throw new TempWorkspaceError('path-in-use', `destination folder "${target}" is already a workspace`, 409)
  }

  // Sessions owned by the temp workspace (header cwd === from). Capture BEFORE
  // the directory move so the registry membership stays readable.
  const oldSessionIds = await workspaceSessionIds(ctx, ws, from)

  // Move the temp workspace's CONTENTS into the user-chosen folder. The folder
  // already exists, so we copy its children into it, then remove the source.
  const children = await readdir(from)
  for (const child of children) {
    await cp(join(from, child), join(target, child), { recursive: true, force: true })
  }
  await rm(from, { recursive: true, force: true }).catch(() => {})

  // Re-register as a permanent workspace at the user-chosen folder.
  let created
  try {
    created = await ctx.workspaceRegistry.create(target, title)
  } catch (error) {
    // Roll back the move so a failed registration does not strand the folder.
    await rm(from, { recursive: true, force: true }).catch(() => {})
    throw new TempWorkspaceError('move-failed', `moved "${from}" but could not register it at "${target}": ${error?.message ?? String(error)}`, 500)
  }

  // Migrate the conversations: rewrite each session log's header cwd and move
  // its log dir into the new cwd's projectKey slot. The session is NOT attached
  // here — the registry's header index was captured at boot (with the old cwd),
  // so an in-session attach would validate against the old (now-deleted) temp
  // path and fail. The registry's session→workspace grouping (bootstrap) only
  // runs once on the first boot; on later boots it only rebuilds the id→cwd
  // index, so it does NOT add the migrated session to the new workspace's
  // sessionIds. We therefore record a durable "pending attach" here and re-attach
  // on the next boot (when the index has the fresh cwd), which the client already
  // prompts the user to do.
  let migrated = 0
  const migratedIds = []
  for (const sessionId of oldSessionIds) {
    try {
      const ok = await migrateSession(ctx, sessionId, from, target, 'zstd')
      if (ok) {
        migrated += 1
        migratedIds.push(sessionId)
        console.log(`[${PLUGIN_ID}] migrated session ${sessionId}; it will attach to "${target}" after the next restart`)
      }
    } catch (error) {
      console.error(`[${PLUGIN_ID}] migrate session ${sessionId} failed`, error)
    }
  }

  // Drop the temp marker entry (this workspace is no longer temporary).
  const list = (await readState()).filter((item) => item.workspaceId !== workspaceId)
  await writeState(list)

  // Delete the OLD registry record if it still exists.
  if (ws !== undefined && ws.id !== created.id) {
    try { await ctx.workspaceRegistry.delete(workspaceId) } catch { /* best-effort */ }
  }

  // Record a pending attach so the next boot re-attaches these migrated sessions
  // to the newly registered workspace (the registry does not auto-group them on
  // an already-initialized boot).
  if (migratedIds.length > 0) {
    await addPendingAttach(created.id, target, migratedIds)
  }

  return { workspace: toView(created), from, target, migratedSessions: migrated }
}

/** A short display title from a path's base name. */
function describeTitle(p) {
  const base = p.replace(/[/\\]+$/, '').split(/[/\\]/).pop()
  return base && base !== '' ? base : '临时工作区'
}

// ── session log migration (zstd-aware) ──────────────────────────────────────
// A DSH session log is a concatenation of independently-decodable Zstandard
// frames: frame 0 is the header line (a single newline-terminated JSON object
// carrying the immutable `cwd`), and the remaining frames are the event
// batches. To migrate a session to a new workspace we only need to rewrite
// frame 0's `cwd` and leave every event frame byte-for-byte intact. The frame
// scanner below only locates the FIRST complete frame (the header) — it never
// decodes the event frames.

const ZSTD_MAGIC_LE = 0xFD2FB528 // 0x28 0xB5 0x2F 0xFD stored little-endian

/** Locate the byte range [start, end) of the first complete zstd frame. */
function firstZstdFrame(buffer) {
  const len = buffer.length
  if (len < 4 || buffer.readUInt32LE(0) !== ZSTD_MAGIC_LE) {
    throw new Error('session log is not a zstandard frame (invalid magic)')
  }
  let offset = 4
  if (offset === len) throw new Error('session log zstd frame truncated in frame header')
  const descriptor = buffer.readUInt8(offset)
  offset += 1
  if ((descriptor & 24) !== 0) throw new Error('session log zstd frame reserved header bit set')
  const contentSizeFlag = descriptor >>> 6
  const singleSegment = (descriptor & 32) !== 0
  const checksum = (descriptor & 4) !== 0
  const dictionaryFlag = descriptor & 3
  const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
  const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
  const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
  if (len - offset < remainingHeaderBytes) throw new Error('session log zstd frame truncated in frame header')
  offset += remainingHeaderBytes
  for (;;) {
    if (len - offset < 3) throw new Error('session log zstd frame truncated in blocks')
    const blockHeader = buffer.readUIntLE(offset, 3)
    offset += 3
    const lastBlock = (blockHeader & 1) !== 0
    const blockType = blockHeader >>> 1 & 3
    const blockSize = blockHeader >>> 3
    if (blockType === 3) throw new Error('session log zstd frame reserved block type')
    offset += blockType === 1 ? 1 : blockSize
    if (lastBlock) break
  }
  if (checksum) {
    if (len - offset < 4) throw new Error('session log zstd frame truncated in checksum')
    offset += 4
  }
  return { start: 0, end: offset }
}

/** zstd frame compression options (checksummed, matching the backend). */
function zstdOptions() {
  // The backend passes its checksum options; a conservative default is fine too.
  return { level: 3 }
}

/**
 * Rewrite the `cwd` field in the header line of a session log and return the
 * new raw artifact bytes. `buf` is the original file bytes; `artifactName`
 * tells whether it is zstd or plaintext. `fromCwd`, when given, must match the
 * current header cwd (aborts on mismatch). Returns null when nothing changed.
 */
async function rewriteSessionCwdBytes(buf, artifactName, fromCwd, toCwd) {
  const isZstd = artifactName.endsWith('.jsonl.zstd')
  let plain
  let tail = Buffer.alloc(0)
  if (isZstd) {
    let frame
    try {
      frame = firstZstdFrame(buf)
      plain = (await zstdDecompressAsync(buf.subarray(frame.start, frame.end))).toString('utf8')
      tail = buf.subarray(frame.end)
    } catch {
      // Fall back to treating the whole file as a single frame.
      plain = (await zstdDecompressAsync(buf)).toString('utf8')
      tail = Buffer.alloc(0)
    }
  } else {
    plain = buf.toString('utf8')
  }

  const nl = plain.indexOf('\n')
  if (nl === -1) return null
  const headerText = plain.slice(0, nl)
  const rest = plain.slice(nl)
  let parsed
  try { parsed = JSON.parse(headerText) } catch { return null }
  if (typeof parsed !== 'object' || parsed === null) return null
  if (fromCwd !== undefined && parsed.cwd !== fromCwd) return null
  if (parsed.cwd === toCwd) return null
  parsed.cwd = toCwd

  const newHeader = JSON.stringify(parsed) + rest
  if (isZstd) {
    const newFrame = await zstdCompressAsync(Buffer.from(newHeader, 'utf8'), zstdOptions())
    return Buffer.concat([newFrame, tail])
  }
  return Buffer.from(newHeader, 'utf8')
}

/** The physical artifact filename a session log uses for a given compression. */
function sessionArtifactName(compression) {
  return compression === 'zstd' ? 'session.jsonl.zstd' : 'session.jsonl'
}

/**
 * List the session ids owned by a workspace: its registry `sessionIds`
 * (canonical-cwd filtered) plus any materialized header whose cwd equals the
 * workspace path (defensive for a record the registry no longer claims).
 */
async function workspaceSessionIds(ctx, ws, path) {
  const ids = new Set(ws?.sessionIds ?? [])
  try {
    const headers = await ctx.sessionPersistence.list()
    for (const meta of headers) if (meta.cwd === path) ids.add(meta.id)
  } catch { /* ignore */ }
  return [...ids]
}

/**
 * Migrate one session to a new cwd: write a rewritten copy of its log into the
 * new cwd's projectKey directory (header frame `cwd` updated, every event
 * frame unchanged), then remove the old session directory. Non-destructive:
 * the destination is written first; the old dir is only removed after success.
 * @returns true on success.
 */
async function migrateSession(ctx, sessionId, oldCwd, newCwd, compression) {
  const oldLoc = ctx.sessionPersistence.locate({ id: sessionId, cwd: oldCwd })
  const newLoc = ctx.sessionPersistence.locate({ id: sessionId, cwd: newCwd })
  if (!oldLoc?.path || !newLoc?.path) return false

  const oldDir = dirname(oldLoc.path)
  const newDir = dirname(newLoc.path)

  // Detect the physical artifact: the backend defaults to zstd, but a session
  // may be stored plaintext (.jsonl). Try the given compression, then the other.
  const preferred = sessionArtifactName(compression)
  const alternate = compression === 'zstd' ? 'session.jsonl' : 'session.jsonl.zstd'
  let artifactName = preferred
  let exists = await stat(join(oldDir, preferred)).then(() => true, () => false)
  if (!exists) {
    const alt = await stat(join(oldDir, alternate)).then(() => true, () => false)
    if (alt) artifactName = alternate
    else return false // nothing materialized on disk — nothing to migrate
  }

  const oldArtifact = join(oldDir, artifactName)
  const newArtifact = join(newDir, artifactName)

  const buf = await readFile(oldArtifact).catch((error) => {
    console.error(`[${PLUGIN_ID}] migrate read failed for ${sessionId}`, error)
    return null
  })
  if (buf === null) return false
  const newBytes = await rewriteSessionCwdBytes(buf, oldArtifact, oldCwd, newCwd)
  if (newBytes === null) return false

  try {
    await mkdir(newDir, { recursive: true, mode: 0o700 })
    await rm(newDir, { recursive: true, force: true }).catch(() => {})
    await mkdir(newDir, { recursive: true, mode: 0o700 })
    await writeFile(newArtifact, newBytes, { mode: 0o600 })
    // Move any other session-owned artifacts (non-header) along verbatim.
    await rm(oldDir, { recursive: true, force: true }).catch(() => {})
    await pruneEmptyProjectDir(dirname(oldDir))
    return true
  } catch (error) {
    console.error(`[${PLUGIN_ID}] migrate write failed for ${sessionId}`, error)
    return false
  }
}

// ── create / delete / list ──────────────────────────────────────────────────
/** Create a temporary workspace (throwaway dir + registry record + marker). */
async function createTempWorkspace(ctx) {
  const dir = join(root(), randomUUID())
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const ws = await ctx.workspaceRegistry.create(dir, TEMP_TITLE)

  const list = await readState()
  list.push({ workspaceId: ws.id, path: ws.path, createdAt: ws.createdAt })
  await writeState(list)

  return { workspace: toView(ws), created: true }
}

/** The temp-workspace marker entries (id + path + createdAt) for the browser. */
async function listTempWorkspaces() {
  return (await readState()).filter((entry) => entry && typeof entry === 'object' && entry.workspaceId)
    .map((entry) => ({ workspaceId: entry.workspaceId, path: entry.path, createdAt: entry.createdAt }))
}

/** Boot cleanup: remove every workspace (sessions + registration) recorded as temporary. */
async function cleanupTempWorkspaces(ctx) {
  const list = await readState()
  if (list.length === 0) return 0
  let removed = 0
  for (const entry of list) {
    if (entry === null || typeof entry !== 'object') continue
    try {
      await deleteTempWorkspace(ctx, entry)
      removed += 1
    } catch (error) {
      console.error(`[${PLUGIN_ID}] cleanup failed for ${entry.workspaceId}`, error)
    }
  }
  // Clear the marker for every entry we processed, regardless of per-entry
  // errors, so a permanently-broken record never blocks later cleanups.
  const processed = new Set(list.map((entry) => entry.workspaceId).filter(Boolean))
  const remaining = (await readState()).filter((entry) => !(entry.workspaceId !== undefined && processed.has(entry.workspaceId)))
  await writeState(remaining)
  return removed
}

/**
 * One-time boot sweep: remove session project directories left behind by temp
 * workspaces that no longer exist. The JSONL store removes individual session
 * dirs and (before this fix) never reaped the now-empty `--<cwd>--` parent, so
 * after repeated create/delete cycles `~/.dsh/sessions` fills with orphaned
 * `--*.dsh-temp-workspaces-*--` folders. Any such project dir whose cwd is NOT
 * still referenced by the temp marker is provably orphaned — its workspace's
 * throwaway directory is already gone — so the whole project dir (sessions
 * included) can be removed. Active temp workspaces (still in the marker) are
 * untouched.
 * @returns the number of orphaned project directories removed.
 */
async function cleanupOrphanTempProjectDirs(ctx) {
  let sessionsRoot
  try { sessionsRoot = ctx.sessionPersistence.root } catch { return 0 }
  if (typeof sessionsRoot !== 'string' || sessionsRoot === '') return 0

  const active = new Set((await readState())
    .filter((entry) => entry && typeof entry === 'object' && entry.path)
    .map((entry) => projectDirName(entry.path)))

  let removed = 0
  let entries
  try { entries = await readdir(sessionsRoot, { withFileTypes: true }) } catch { return 0 }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const name = entry.name
    // Only temp-workspace project dirs: `--...dsh-temp-workspaces-...--`. This
    // filter deliberately skips ordinary project dirs (e.g. the user's real cwd,
    // or the permanent-keep destination folders created while testing) so they
    // are never touched.
    if (!name.startsWith('--') || !name.endsWith('--')) continue
    if (!name.includes('dsh-temp-workspaces-')) continue
    if (active.has(name)) continue // a live temp workspace still owns this dir
    const dir = join(sessionsRoot, name)
    try {
      await rm(dir, { recursive: true, force: true })
      removed += 1
      console.log(`[${PLUGIN_ID}] cleared orphaned temp-workspace session dir ${name}`)
    } catch (error) {
      console.error(`[${PLUGIN_ID}] could not clear orphaned dir ${name}`, error)
    }
  }

  // Also reap orphaned throwaway directories directly under the temp root: the
  // durable state.json is the source of truth for which throwaway dirs are live,
  // so any `<uuid>` dir there that is no longer referenced is provably a leftover
  // (its marker entry was already cleared by a prior delete). These are the
  // actual "临时工作区" folders and would otherwise accumulate beside state.json.
  const troot = root()
  let tentries
  try { tentries = await readdir(troot, { withFileTypes: true }) } catch { return removed }
  const activePaths = new Set((await readState()).filter((e) => e && typeof e === 'object' && e.path).map((e) => e.path))
  for (const entry of tentries) {
    if (!entry.isDirectory()) continue
    const dir = join(troot, entry.name)
    if (activePaths.has(dir)) continue
    // Never touch our own infra files if a directory somehow collides by name.
    if (entry.name === 'state.json' || entry.name === 'pending-attach.json') continue
    try {
      await rm(dir, { recursive: true, force: true })
      removed += 1
      console.log(`[${PLUGIN_ID}] cleared orphaned throwaway dir ${entry.name}`)
    } catch (error) {
      console.error(`[${PLUGIN_ID}] could not clear orphaned throwaway dir ${entry.name}`, error)
    }
  }
  return removed
}

/**
 * One-time boot sweep that reclaims the DURABLE metadata residue a temp
 * workspace leaves behind after its session dirs are gone: the projection
 * cache rows (`session_projcache` domain), the archived-id entries the
 * archive fallback adds, and the legacy per-session cache files from an
 * older storage layout. These rows are identity-checked (so they never
 * surface a ghost conversation by themselves), but they ARE a trace, and
 * the plugin's contract is "no trace".
 *
 * A row is provably orphaned when its recorded `cwd` lives under the temp
 * root (`~/.dsh/temp-workspaces`) and is NOT still referenced by the marker —
 * its workspace's throwaway dir is already gone. Active temp workspaces
 * (still in the marker) are untouched, and rows for real (non-temp) cwds
 * are never considered. The archived-id removal is scoped the same way, so
 * the user's intentional archives of real conversations are never touched.
 * @returns the number of projection-cache rows pruned.
 */
async function pruneOrphanTempResidue(ctx) {
  const cache = (typeof ctx.get === 'function' && ctx.get('sessionProjectionCache')) || ctx.sessionProjectionCache
  if (!cache || !cache.table || typeof cache.table.keys !== 'function' || typeof cache.table.get !== 'function') return 0
  const active = new Set((await readState())
    .filter((entry) => entry && typeof entry === 'object' && entry.path)
    .map((entry) => entry.path))
  const troot = root()

  const orphanIds = []
  for (const id of cache.table.keys()) {
    const record = cache.table.get(id)
    const cwd = record && record.identity ? record.identity.cwd : undefined
    if (typeof cwd !== 'string') continue
    if (cwd !== troot && !cwd.startsWith(troot + '/')) continue // not a temp-workspace cwd
    if (active.has(cwd)) continue // a live temp workspace still owns this row
    orphanIds.push(id)
  }
  if (orphanIds.length === 0) return 0

  // Un-archive the orphaned temp sessions so the registry's durable archive
  // set stops accumulating temp residue (scoped to exactly the ids above).
  try {
    const registry = ctx.workspaceRegistry
    if (registry && registry.global && typeof registry.global.get === 'function' && typeof registry.global.set === 'function') {
      const state = registry.global.get()
      const removed = new Set(orphanIds)
      const kept = state.archivedSessionIds.filter((id) => !removed.has(id))
      if (kept.length !== state.archivedSessionIds.length) {
        state.archivedSessionIds = kept
        await registry.global.set(state)
      }
    }
  } catch (error) {
    console.error(`[${PLUGIN_ID}] could not un-archive orphaned temp sessions`, error)
  }

  let pruned = 0
  for (const id of orphanIds) {
    try {
      if (typeof cache.table.delete === 'function') {
        await cache.table.delete(id)
        pruned += 1
      }
    } catch { /* best-effort */ }
    await rm(legacyProjectionCacheFile(id), { force: true }).catch(() => {})
  }
  if (pruned > 0) console.log(`[${PLUGIN_ID}] pruned ${pruned} orphaned temp-workspace projection-cache row(s)`)
  return pruned
}

// ── wire helpers (mirror dsh-better-sidebar / dsh-git-graph) ────────────────
export class TempWorkspaceError extends Error {
  constructor(code, message, status = 400) {
    super(message)
    this.code = code
    this.status = status
  }
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
      if (body.length > 4 * 1024 * 1024) {
        req.destroy()
        reject(new TempWorkspaceError('payload-too-large', 'request body too large', 413))
      }
    })
    req.on('end', () => {
      try { resolve(body === '' ? {} : JSON.parse(body)) } catch { reject(new TempWorkspaceError('bad-json', 'invalid JSON body', 400)) }
    })
    req.on('error', reject)
  })
}

function writeJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

function writeOk(res, value) {
  writeJson(res, 200, { ok: true, value })
}

function writeError(res, error) {
  const err = error instanceof Error ? error : new Error(String(error))
  const status = err instanceof TempWorkspaceError ? err.status : 500
  writeJson(res, status, { ok: false, error: { code: err.code ?? 'error', message: err.message } })
}

/** Same-origin / trusted-host check, mirroring the git-graph/better-sidebar fence. */
function isLoopback(hostname) {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]'
}

// ── self-restart (ported from dsh-market's proven restart.js) ────────────────
// The "Restart now" button triggers a real host-level restart, not just a page
// reload: a detached helper respawns the exact DSH invocation once this host
// releases its port, then this process terminates itself. Safety model mirrors
// dsh-market: direct same-origin loopback only, no forwarding headers, and the
// port is read off the request so the replacement takes over the same one.

/** The Node binary running this process (prefer argv0 when it is an absolute exe). */
function nodeExecutable(argv0 = process.argv0, execPath = process.execPath) {
  if (argv0 !== undefined && argv0 !== '' && isAbsolute(argv0) && existsSync(argv0)) return argv0
  return execPath
}

/** The exact DSH entry this process booted with (mirrors dsh-market's dshArgv). */
function dshArgv() {
  const entry = process.argv[1]
  if (entry !== undefined && /[\\/](?:bin\.(?:js|ts)|dsh)$/.test(entry)) {
    const abs = resolve(entry)
    return { file: nodeExecutable(), args: [...process.execArgv, abs], cwd: dirname(abs), viaShell: false }
  }
  return { file: 'dsh', args: [], cwd: undefined, viaShell: process.platform === 'win32' }
}

/** The exact boot invocation the detached restart helper replays. */
function restartLaunch() {
  const launch = dshArgv()
  return {
    ...launch,
    args: [...launch.args, ...process.argv.slice(2)],
    cwd: launch.cwd ?? process.cwd(),
  }
}

/** Platform-correct spawn invocation (Windows gets a hidden console). */
function respawnInvocation(launch, platform = process.platform) {
  if (platform !== 'win32') return { file: launch.file, args: launch.args, viaShell: launch.viaShell, detached: true }
  const quote = (p) => `'${p.replace(/'/g, "''")}'`
  return {
    file: 'powershell.exe',
    args: ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', [`& ${quote(launch.file)}`, ...launch.args.map(quote)].join(' ')],
    viaShell: false,
    detached: false,
  }
}

/** Source for the detached helper that outlives this process and brings the replacement up. */
function restartHelperSource(spawned, launch, logs, port) {
  return [
    "const { spawn } = require('node:child_process')",
    "const fs = require('node:fs')",
    "const net = require('node:net')",
    `const file = ${JSON.stringify(spawned.file)}`,
    `const args = ${JSON.stringify(spawned.args)}`,
    `const cwd = ${JSON.stringify(launch.cwd)}`,
    `const viaShell = ${JSON.stringify(spawned.viaShell)}`,
    `const detached = ${JSON.stringify(spawned.detached)}`,
    `const logOut = ${JSON.stringify(logs.out)}`,
    `const logErr = ${JSON.stringify(logs.err)}`,
    `const port = ${JSON.stringify(port)}`,
    'const sleep = (ms) => new Promise((r) => setTimeout(r, ms))',
    'const note = (line) => { try { fs.appendFileSync(logErr, `[temp-workspace] ${line}\\n`) } catch {} }',
    'const listening = () => new Promise((resolve) => {',
    '  const probe = net.connect({ host: "127.0.0.1", port })',
    '  const done = (value) => { probe.destroy(); resolve(value) }',
    '  probe.on("connect", () => done(true))',
    '  probe.on("error", () => done(false))',
    '  setTimeout(() => done(false), 500)',
    '})',
    'const main = async () => {',
    '  if (port) {',
    '    const until = Date.now() + 30000',
    '    while (Date.now() < until && await listening()) await sleep(250)',
    '    if (await listening()) note(`port ${port} was still in use after 30s; starting anyway`)',
    '    await sleep(300)',
    '  } else { await sleep(1500) }',
    '  let child',
    '  try {',
    '    const out = fs.openSync(logOut, "a")',
    '    const err = fs.openSync(logErr, "a")',
    '    child = spawn(file, args, { cwd, detached, stdio: ["ignore", out, err], env: process.env, shell: viaShell })',
    '    child.on("error", (error) => note(`could not start the replacement: ${error && error.message ? error.message : error}`))',
    '    child.unref()',
    '  } catch (error) {',
    '    note(`could not start the replacement: ${error && error.message ? error.message : error}`)',
    '    return',
    '  }',
    '  if (!port) { await sleep(3000); return }',
    '  const upBy = Date.now() + 20000',
    '  while (Date.now() < upBy && !(await listening())) await sleep(500)',
    '  if (!(await listening())) note(`the replacement did not bind port ${port} within 20s — see the output log beside this one`)',
    '}',
    'main()',
  ].join('\n')
}

/** The port this process serves on, read off the request that asked for the restart. */
function servingPort(request) {
  const host = request.headers.host
  if (host === undefined) return null
  const match = /:(\d{1,5})$/u.exec(host)
  if (match === null) return null
  const port = Number(match[1])
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : null
}

/** Whether a process-control request came from this Web host on loopback. */
function trustedRestartRequest(request) {
  const address = request.socket.remoteAddress
  if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') return false
  if (request.headers.forwarded !== undefined || request.headers['x-forwarded-for'] !== undefined || request.headers['x-real-ip'] !== undefined) return false
  const origin = request.headers.origin
  const host = request.headers.host
  if (origin === undefined || host === undefined) return false
  try {
    const parsed = new URL(origin)
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.host === host
  } catch {
    return false
  }
}

/** Relaunch the exact DSH entry, then stop this process. */
async function scheduleRestart(port) {
  const launch = restartLaunch()
  const spawned = respawnInvocation(launch)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const logOut = join(tmpdir(), `temp-workspace-restart-${stamp}.out.log`)
  const logErr = join(tmpdir(), `temp-workspace-restart-${stamp}.err.log`)
  const helper = spawn(nodeExecutable(), ['-e', restartHelperSource(spawned, launch, { out: logOut, err: logErr }, port)], {
    detached: true,
    stdio: 'ignore',
    env: process.env,
  })
  helper.unref()
  // Give the response a moment to reach the browser, then terminate this host.
  setTimeout(() => process.kill(process.pid, 'SIGTERM'), 500)
  return { pid: process.pid, helperPid: helper.pid, logOut, logErr }
}

export const inject = ['webServer', 'webRuntime', 'workspaceRegistry', 'sessionPersistence', 'settings', 'loader']

export async function apply(ctx) {
  const trustedHosts = ctx.webRuntime?.trustedHosts ?? []

  // ── settings ─────────────────────────────────────────────────────────────
  // Register this plugin's settings namespace host-side (defaults, schema, and
  // the user-editable section in ~/.dsh/settings.yaml). The browser card reads
  // and writes the same namespace (via its own /temp-workspace/api/config
  // route); the boot cleanup below reads it to decide delete timing and whether
  // to confirm first. Mirrors dsh-workspace-auto-approval's use of the loader
  // for the schemastery builder.
  let settingsScope
  try {
    const schemaModule = await ctx.loader.import('@deepseek-ai/schemastery')
    const z = schemaModule?.default ?? schemaModule
    const schema = z.object({
      deleteMode: z.union([z.const('immediate'), z.const('delayed')]).default('immediate'),
      deleteDelay: z.number().min(0).default(3600),
      confirmBeforeDelete: z.boolean().default(true),
    })
    settingsScope = ctx.settings.register(SETTINGS_NS, schema)
  } catch (error) {
    console.error(`[${PLUGIN_ID}] settings registration failed; using defaults`, error)
    settingsScope = undefined
  }

  /** Read the resolved settings, merging schema defaults over any missing key. */
  function readSettings() {
    const value = (() => {
      try { return settingsScope === undefined ? undefined : settingsScope.get() } catch { return undefined }
    })()
    return {
      deleteMode: value?.deleteMode ?? DEFAULT_SETTINGS.deleteMode,
      deleteDelay: Number(value?.deleteDelay ?? DEFAULT_SETTINGS.deleteDelay),
      confirmBeforeDelete: value?.confirmBeforeDelete ?? DEFAULT_SETTINGS.confirmBeforeDelete,
    }
  }

  // ── native-delete hook ───────────────────────────────────────────────────
  // DSH's workspace registry delete retains the workspace directory AND every
  // session log (it only removes the registration). So deleting a temp
  // workspace via the sidebar would leave its conversations behind until a
  // boot-time cleanup. Wrap the registry delete so that, whenever the deleted
  // workspace is one recorded in the temp marker, we immediately reap its
  // conversations + throwaway dir + marker entry. Non-temp workspaces (not in
  // the marker) are unaffected, and the plugin's own cleanup path calls the
  // unwrapped delete to avoid re-entering this hook.
  {
    const nativeDelete = ctx.workspaceRegistry.delete.bind(ctx.workspaceRegistry)
    registryDeleteUnwrapped = nativeDelete
    ctx.workspaceRegistry.delete = async (id) => {
      const result = await nativeDelete(id)
      try {
        const entry = (await readState()).find((item) => item?.workspaceId === id)
        if (entry !== undefined) await reapTempWorkspaceFiles(ctx, entry)
      } catch (error) {
        console.error(`[${PLUGIN_ID}] temp-workspace cleanup after delete failed for ${id}`, error)
      }
      return result
    }
  }

  const fence = (req) => {
    try {
      const authority = (req.headers?.host ?? '')
      const hostname = authority.replace(/:\d+$/, '')
      if (isLoopback(hostname)) return true
      return trustedHosts.some((entry) => (entry ?? '') === hostname || (entry ?? '').replace(/:\d+$/, '') === hostname)
    } catch {
      return false
    }
  }

  // ── boot cleanup (settings-driven) ───────────────────────────────────────
  // Read the marker + resolved settings and decide what to do on this boot:
  //   - confirmBeforeDelete ON  : never auto-delete; expose the pending set and
  //     wait for the browser to confirm (delete) or keep it. Nothing is removed
  //     until the user answers, so an unattended boot never loses work.
  //   - confirmBeforeDelete OFF : delete automatically — immediately, or after
  //     deleteDelay seconds when deleteMode === 'delayed'.
  // The pending list + timing are captured so the /pending route can drive the
  // browser popup without re-reading the marker on every poll.
  const pending = new Map() // workspaceId -> marker entry awaiting confirmation
  // Whether the user already answered the boot prompt this host-lifetime
  // (keep / delete / permanent-keep). Once answered, /pending reports nothing
  // pending so the dialog never re-appears for the same boot, even though a
  // temp-keep keeps the workspaces in the marker for a FUTURE boot.
  let bootAnswered = false

  /** When to run the deletion confirm/action, as an epoch-ms timestamp. */
  function deleteAtMs(settings) {
    return Date.now() + (settings.deleteMode === 'delayed' ? (settings.deleteDelay * 1000) : 0)
  }

  // A fixed boot-relative deadline (epoch ms) so a delayed confirm doesn't
  // slide forever on every /pending poll. Captured once, at boot.
  const bootDeadline = deleteAtMs(readSettings())

  async function runBootCleanup(settings) {
    const list = await readState()
    if (list.length === 0) return
    if (settings.confirmBeforeDelete) {
      // Hold the set for the browser to confirm. Keep the marker intact so a
      // user who never answers still has the workspaces next boot.
      bootAnswered = false
      for (const entry of list) if (entry?.workspaceId) pending.set(entry.workspaceId, entry)
      console.log(`[${PLUGIN_ID}] awaiting confirmation to delete ${list.length} temporary workspace(s)`)
      return
    }
    // No confirmation required: remove now or schedule the removal.
    if (settings.deleteMode === 'delayed' && settings.deleteDelay > 0) {
      const ms = settings.deleteDelay * 1000
      console.log(`[${PLUGIN_ID}] scheduling deletion of ${list.length} temporary workspace(s) in ${ms}ms`)
      const timer = setTimeout(() => {
        void cleanupTempWorkspaces(ctx)
          .then((removed) => { if (removed > 0) console.log(`[${PLUGIN_ID}] removed ${removed} temporary workspace(s) after delay`) })
          .catch((error) => console.error(`[${PLUGIN_ID}] delayed boot cleanup failed`, error))
      }, ms)
      timer.unref?.()
      return
    }
    const removed = await cleanupTempWorkspaces(ctx)
    if (removed > 0) console.log(`[${PLUGIN_ID}] removed ${removed} temporary workspace(s) on boot`)
  }

  /** The marker entries currently held for confirmation, with a marker fallback. */
  async function heldEntries() {
    if (pending.size > 0) return [...pending.values()]
    // The in-memory cache may not be populated yet (boot cleanup is async, and
    // the browser can poll before it settles). Fall back to the durable marker
    // so a confirm decision never silently loses workspaces.
    const settings = readSettings()
    if (!settings.confirmBeforeDelete) return []
    return (await readState()).filter((entry) => entry?.workspaceId)
  }

  void runBootCleanup(readSettings())
    .catch((error) => console.error(`[${PLUGIN_ID}] boot cleanup failed`, error))

  // Re-attach migrated sessions to their new permanent workspace. This runs at
  // boot, after the workspace registry initialized and indexed the migrated
  // headers with the new cwd — so `attachSession` validates against the new path
  // and succeeds. Without this, an already-initialized registry never groups the
  // migrated sessions and they end up ungrouped.
  void reattachPendingSessions(ctx)
    .then((n) => { if (n > 0) console.log(`[${PLUGIN_ID}] re-attached ${n} migrated session(s) after restart`) })
    .catch((error) => console.error(`[${PLUGIN_ID}] pending re-attach failed`, error))

  // Reap leftover temp-workspace session project dirs from prior create/delete
  // cycles (the store never pruned the empty `--<cwd>--` parent). Runs alone so
  // it also fixes dirs orphaned before this version.
  void cleanupOrphanTempProjectDirs(ctx)
    .then((removed) => { if (removed > 0) console.log(`[${PLUGIN_ID}] swept ${removed} orphaned temp-workspace session dir(s)`) })
    .catch((error) => console.error(`[${PLUGIN_ID}] orphaned-dir sweep failed`, error))

  // Reclaim the durable metadata residue of already-deleted temp workspaces:
  // projection-cache rows, archived-id entries, and legacy per-session cache
  // files. Identity-checked reads never surface them as conversations, but
  // "no trace" means no trace — this is the authoritative net behind the
  // delete-time pruning in `removeLiveSessions`. The projection cache may
  // still be initializing when `apply` runs (this plugin does not inject it),
  // so retry until its table is ready.
  const sweepResidue = (attempt) => {
    const cache = (typeof ctx.get === 'function' && ctx.get('sessionProjectionCache')) || ctx.sessionProjectionCache
    if (!cache || !cache.table) {
      if (attempt < 10) setTimeout(() => sweepResidue(attempt + 1), 2000)
      return
    }
    void pruneOrphanTempResidue(ctx)
      .catch((error) => console.error(`[${PLUGIN_ID}] orphaned projection-cache sweep failed`, error))
  }
  sweepResidue(0)

  // ── dispatch ─────────────────────────────────────────────────────────────
  const dispatch = {
    create: async () => createTempWorkspace(ctx),
    list: async () => ({ entries: await listTempWorkspaces() }),
    delete: async (payload) => {
      if (typeof payload?.workspaceId !== 'string' || payload.workspaceId === '') {
        throw new TempWorkspaceError('bad-arg', 'missing string "workspaceId"', 400)
      }
      // Use the marker entry (which carries the durable path) so a workspace
      // whose registry record is already gone still reaps its folder.
      const entry = (await readState()).find((item) => item.workspaceId === payload.workspaceId)
      await deleteTempWorkspace(ctx, entry ?? { workspaceId: payload.workspaceId, path: undefined })
      return { ok: true }
    },
    // Settings read/write for the Settings -> Plugins card (mirrors the
    // workspace-auto-approval /config contract).
    config: async (payload) => {
      const settings = readSettings()
      if (payload && typeof payload === 'object' && !Array.isArray(payload) && Object.keys(payload).length > 0) {
        await writeSettings(payload)
        return readSettings()
      }
      return settings
    },
    // Restore every settings field to its default (empties the user layer).
    configReset: async () => {
      await writeSettings(null)
      return readSettings()
    },
    // Pending-confirmation state for the boot popup.
    pending: async () => {
      const settings = readSettings()
      if (bootAnswered) return { pending: [], confirmBeforeDelete: settings.confirmBeforeDelete, deleteMode: settings.deleteMode, deleteAt: bootDeadline, pendingCount: 0 }
      const entries = await heldEntries()
      return {
        pending: entries.map((entry) => ({ workspaceId: entry.workspaceId, path: entry.path, createdAt: entry.createdAt })),
        confirmBeforeDelete: settings.confirmBeforeDelete,
        deleteMode: settings.deleteMode,
        deleteAt: bootDeadline,
        pendingCount: entries.length,
      }
    },
    // User confirmed: delete the held set now.
    confirm: async () => {
      bootAnswered = true
      const entries = await heldEntries()
      pending.clear()
      for (const entry of entries) {
        try { await deleteTempWorkspace(ctx, entry) } catch (error) { console.error(`[${PLUGIN_ID}] confirmed delete failed for ${entry?.workspaceId}`, error) }
      }
      return { deleted: entries.length }
    },
    // User chose "temporary keep": preserve these workspaces but keep them
    // temporary (they stay in the marker and are subject to cleanup again on a
    // later boot). Only the in-memory hold is released.
    keep: async () => {
      bootAnswered = true
      const entries = await heldEntries()
      pending.clear()
      return { kept: entries.length }
    },
    // Permanent keep: use the user-chosen folder directly as the permanent
    // workspace (move the temp files in, name it after the folder). With an
    // explicit workspaceId (from the per-row button) only that temp workspace is
    // moved; otherwise every held temp workspace is moved.
    permanentKeep: async (payload) => {
      const target = typeof payload?.target === 'string' && payload.target !== '' ? payload.target : undefined
      if (target === undefined) throw new TempWorkspaceError('bad-arg', 'missing string "target"', 400)
      const explicitId = typeof payload?.workspaceId === 'string' && payload.workspaceId !== '' ? payload.workspaceId : undefined
      let entries
      if (explicitId !== undefined) {
        bootAnswered = true
        const marker = await readState()
        const entry = marker.find((item) => item?.workspaceId === explicitId)
        entries = entry === undefined ? [] : [entry]
      } else {
        bootAnswered = true
        entries = await heldEntries()
      }
      if (entries.length === 0) return { moved: [] }
      const moved = []
      for (const entry of entries) {
        try {
          moved.push(await moveTempWorkspace(ctx, entry, target))
        } catch (error) {
          console.error(`[${PLUGIN_ID}] permanent-keep move failed for ${entry?.workspaceId}`, error)
          throw error
        }
      }
      return { moved }
    },
  }

  async function writeSettings(patch) {
    if (settingsScope === undefined) return
    // `null` (or an empty patch) resets the whole user layer back to defaults.
    if (patch === null) {
      await settingsScope.replace({})
      return
    }
    // Normalize a partial patch over the defaulted current value, validating
    // deleteMode against its literal union and coercing numerics.
    const next = { ...readSettings(), ...(patch ?? {}) }
    if (next.deleteMode !== 'immediate' && next.deleteMode !== 'delayed') {
      throw new TempWorkspaceError('bad-arg', 'deleteMode must be "immediate" or "delayed"', 400)
    }
    const delay = Number(next.deleteDelay)
    if (!Number.isFinite(delay) || delay < 0) {
      throw new TempWorkspaceError('bad-arg', 'deleteDelay must be a non-negative number', 400)
    }
    await settingsScope.update({
      deleteMode: next.deleteMode,
      deleteDelay: Math.floor(delay),
      confirmBeforeDelete: Boolean(next.confirmBeforeDelete),
    })
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/temp-workspace/api',
    handler: async (req, res) => {
      if (!fence(req)) { writeJson(res, 403, { ok: false, error: { code: 'forbidden', message: 'forbidden' } }); return }
      // Reads (config GET, pending GET) use GET; mutations use POST.
      const isRead = req.method === 'GET'
      if (!isRead && req.method !== 'POST') { writeJson(res, 405, { ok: false, error: { code: 'method-error', message: 'method not allowed' } }); return }
      const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname
      const method = pathname.startsWith('/temp-workspace/api/') ? pathname.slice('/temp-workspace/api/'.length) : undefined
      if (method === undefined || method.includes('/')) { writeError(res, new TempWorkspaceError('not-found', 'unknown temp-workspace method', 404)); return }

      // Restart needs the raw request (port, socket, Origin), so handle it
      // before the payload-dispatch path. Same guard as dsh-market: direct
      // same-origin loopback, no forwarding headers.
      if (method === 'restart') {
        if (!trustedRestartRequest(req)) { writeJson(res, 403, { ok: false, error: { code: 'forbidden', message: 'restart requires a same-origin loopback request' } }); return }
        if (req.method !== 'POST') { writeJson(res, 405, { ok: false, error: { code: 'method-error', message: 'method not allowed' } }); return }
        const port = servingPort(req)
        const result = await scheduleRestart(port)
        writeOk(res, { restarting: true, ...result })
        return
      }

      try {
        const payload = isRead ? {} : await readJsonBody(req)
        const handler = dispatch[method]
        if (handler === undefined) throw new TempWorkspaceError('not-found', `unknown temp-workspace method "${method}"`, 404)
        writeOk(res, await handler(payload))
      } catch (error) {
        writeError(res, error)
      }
    },
  }), `${PLUGIN_ID}: /temp-workspace/api routes`)
}
