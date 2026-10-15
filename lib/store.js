/**
 * The plugin's own store: applications the person added from the UI, and
 * applications they removed from the menu.
 *
 * ## Why removals are recorded here instead of deleting from the config
 *
 * Applications reach the menu from two sources: the operator's hand-written
 * `config.apps` in `cordis.patch.yml`, and this file. A first version made
 * only the second source removable, which meant the apps most likely to be on
 * screen — the ones the profile ships declared — could not be removed at all.
 * That is the wrong behaviour: whether a menu entry can be dismissed is a
 * question about the *menu*, not about where the entry was written down.
 *
 * So removal is a fact this file records, uniformly, for either source:
 * `hidden` is a list of ids the menu must not offer. A declared app stays in
 * the hand-written config (a plugin must never rewrite the operator's
 * document, and the next hand edit would then have to merge machine-written
 * rows), and an added app is both dropped from `apps` and remembered as
 * hidden, so re-adding the same bundle does not resurrect it unexpectedly.
 *
 * Because a removal is recorded rather than erased, it is reversible: the
 * manage dialog lists hidden applications and can restore them.
 * @module dsh-open-workspace-any-app/store
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** Environment variable that relocates the DSH home (highest precedence). */
const DSH_HOME_ENV = 'DSH_HOME';

/** Directory name for the default DSH home under the OS home. */
const DSH_HOME_DIR_NAME = '.dsh';

/** Store file name inside the plugin's home directory. */
const STORE_FILE = 'apps.json';

/** Plugin directory inside the DSH home. */
const STORE_DIR = 'open-workspace-any-app';

/**
 * Store schema version.
 *
 * Version 1 held a bare `apps` array and had no way to record a removal; a v1
 * document is read as "these apps were added, nothing was hidden" so an
 * existing store keeps working instead of being discarded.
 */
const STORE_VERSION = 2;

/** Version that is read but upgraded. */
const STORE_VERSION_LEGACY = 1;

/** Cap on stored entries: a bound keeps one runaway UI session off the menu. */
export const MAX_USER_APPS = 100;

/** Cap on hidden ids, matching the entry bound so both lists stay bounded. */
export const MAX_HIDDEN = 200;

/** Cap on a stored id or label, matching the config schema's own bound. */
const MAX_TEXT = 4096;

/**
 * @typedef {object} StoredApp
 * @property {string} id - menu id.
 * @property {string} label - display name.
 * @property {string} path - absolute application bundle path.
 */

/**
 * @typedef {object} StoreDocument
 * @property {StoredApp[]} apps - applications the UI added.
 * @property {string[]} hidden - ids the menu must not offer.
 */

/** An empty document. */
export const EMPTY_STORE = { apps: [], hidden: [] };

/**
 * Resolve the DSH home the way the harness documents it: an explicit value,
 * then `$DSH_HOME`, then `~/.dsh`. A blank override is treated as unset so a
 * stray empty variable never resolves the home to the current directory.
 * @param {NodeJS.ProcessEnv} env - environment to read.
 * @param {string} home - OS home directory.
 * @returns {string} the absolute DSH home path.
 */
export function resolveDshHome(env, home) {
  const configured = env[DSH_HOME_ENV];
  if (configured !== undefined && configured.trim().length > 0) return configured;
  return join(home, DSH_HOME_DIR_NAME);
}

/**
 * The store file's absolute path.
 *
 * An explicit `dir` wins so a test or a second harness home can keep its
 * additions out of the operator's real `~/.dsh` tree; otherwise the store
 * lives under the resolved DSH home.
 * @param {NodeJS.ProcessEnv} env - environment to read.
 * @param {string} home - OS home directory.
 * @param {string} [dir] - explicit store directory override.
 * @returns {string} the absolute path.
 */
export function storePath(env, home, dir) {
  return join(dir ?? join(resolveDshHome(env, home), STORE_DIR), STORE_FILE);
}

/**
 * Turn a label or path into a stable, schema-legal id.
 *
 * The id addresses the app in the launch request and the icon URL, so it must
 * match the config schema's id pattern; a label that is entirely punctuation
 * falls back to a generic stem rather than producing an empty id.
 * @param {string} label - the label the person typed, or the path's basename.
 * @returns {string} a candidate id, unique per label but not yet deduplicated.
 */
export function slugify(label) {
  const slug = label
    .toLowerCase()
    .replace(/\.app$/u, '')
    .replace(/[^a-z0-9._-]+/gu, '-')
    .replace(/^[^a-z0-9]+/u, '')
    .replace(/-+$/u, '')
    .slice(0, 64);
  return slug === '' ? 'app' : slug;
}

/**
 * Read one stored app entry, or null when it is unusable.
 * @param {unknown} entry - raw JSON value.
 * @param {boolean} requirePath - whether a bundle path is required.
 * @returns {StoredApp|null} the entry, or null when malformed.
 */
function readEntry(entry, requirePath) {
  if (typeof entry !== 'object' || entry === null) return null;
  const { id, label, path } = entry;
  if (typeof id !== 'string' || id === '' || id.length > MAX_TEXT) return null;
  if (requirePath) {
    if (typeof path !== 'string' || path === '' || path.length > MAX_TEXT) return null;
    return { id, label: typeof label === 'string' && label !== '' ? label : id, path };
  }
  // A hidden marker only needs an id: the label and path come from whichever
  // source still offers the app.
  return { id, label: typeof label === 'string' ? label : '', path: '' };
}

/**
 * Read the stored document.
 *
 * A missing, unreadable, malformed, or future-versioned store reads as empty:
 * this is a convenience list, and a corrupt one must never keep the menu from
 * rendering the operator-declared applications. A version-1 document is
 * upgraded rather than discarded, because it holds real additions.
 * @param {string} path - store file path.
 * @returns {Promise<StoreDocument>} the document.
 */
export async function readStore(path) {
  let raw;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    // Swallows ENOENT/EACCES: no store yet, or one this process cannot read.
    return { ...EMPTY_STORE };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...EMPTY_STORE };
  }
  if (typeof parsed !== 'object' || parsed === null) return { ...EMPTY_STORE };
  if (parsed.version !== STORE_VERSION && parsed.version !== STORE_VERSION_LEGACY) return { ...EMPTY_STORE };
  if (!Array.isArray(parsed.apps)) return { ...EMPTY_STORE };

  const apps = parsed.apps
    .flatMap((entry) => {
      const read = readEntry(entry, true);
      return read === null ? [] : [read];
    })
    .slice(0, MAX_USER_APPS);
  // v1 has no `hidden` list; upgrading it yields "nothing was removed".
  const hidden = Array.isArray(parsed.hidden)
    ? parsed.hidden
      .flatMap((value) => (typeof value === 'string' && value !== '' && value.length <= MAX_TEXT ? [value] : []))
      .slice(0, MAX_HIDDEN)
    : [];
  return { apps, hidden };
}

/**
 * Read only the applications the UI added.
 * @param {string} path - store file path.
 * @returns {Promise<StoredApp[]>} the added applications.
 */
export async function readUserApps(path) {
  return (await readStore(path)).apps;
}

/**
 * Persist the store atomically.
 *
 * A temp file plus rename means a reader observes either the old complete
 * document or the new one, never a half-written list. The temp file is a
 * sibling so the rename stays on one filesystem.
 * @param {string} path - store file path.
 * @param {StoreDocument} document - the document to persist.
 * @returns {Promise<void>} resolves once the new document is in place.
 */
export async function writeStore(path, document) {
  const body = `${JSON.stringify({ version: STORE_VERSION, apps: document.apps, hidden: document.hidden }, null, 2)}\n`;
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${String(process.pid)}.${Date.now().toString(36)}.tmp`;
  await writeFile(temp, body, { mode: 0o600 });
  await rename(temp, path);
}

/**
 * Add one application, replacing any entry that already answers to the same
 * id or names the same bundle path, and clearing any removal of that id.
 *
 * Replacing rather than appending means re-adding a bundle updates its label
 * instead of offering the app twice under one id; clearing the removal means
 * "add" always makes the app visible, which is what the person just asked for.
 * @param {StoreDocument} document - current document.
 * @param {StoredApp} entry - the entry to add.
 * @returns {StoreDocument} the new document.
 * @throws {Error} when the list is already at its bound.
 */
export function addUserApp(document, entry) {
  const kept = document.apps.filter((existing) => existing.id !== entry.id && existing.path !== entry.path);
  if (kept.length >= MAX_USER_APPS) {
    throw new Error(`dsh-open-workspace-any-app: at most ${String(MAX_USER_APPS)} added applications`);
  }
  return {
    apps: [...kept, entry],
    hidden: document.hidden.filter((id) => id !== entry.id),
  };
}

/**
 * Record that one id must not be offered, dropping any stored entry for it.
 *
 * The id is remembered even when the app is only declared in the config: that
 * is what makes a declared entry removable without rewriting the operator's
 * document.
 * @param {StoreDocument} document - current document.
 * @param {string} id - the id to remove.
 * @returns {StoreDocument} the new document.
 */
export function removeUserApp(document, id) {
  const hidden = document.hidden.includes(id) ? document.hidden : [...document.hidden, id];
  return {
    apps: document.apps.filter((existing) => existing.id !== id),
    hidden: hidden.slice(0, MAX_HIDDEN),
  };
}

/**
 * Clear one removal, so the app becomes visible again.
 * @param {StoreDocument} document - current document.
 * @param {string} id - the id to restore.
 * @returns {StoreDocument} the new document.
 */
export function restoreUserApp(document, id) {
  return { apps: document.apps, hidden: document.hidden.filter((existing) => existing !== id) };
}

/**
 * Choose an id that no declared application or stored entry already uses.
 * @param {string} stem - the slug to start from.
 * @param {Iterable<string>} taken - ids already in use.
 * @returns {string} an unused id.
 */
export function uniqueId(stem, taken) {
  const used = new Set(taken);
  if (!used.has(stem)) return stem;
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${stem}-${String(n)}`;
    if (!used.has(candidate)) return candidate;
  }
  /* c8 ignore next -- 999 collisions on one stem is not a reachable UI state */
  return `${stem}-${Date.now().toString(36)}`;
}
