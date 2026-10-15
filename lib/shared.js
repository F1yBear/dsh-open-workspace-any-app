/**
 * Wire contract shared verbatim by the host routes and the browser bundle:
 * the route paths this plugin owns and the JSON shapes they exchange.
 *
 * Both halves are built independently, so every path and field name lives
 * here as a literal. Nothing in this module imports Node or React — it is
 * browser-safe by construction, the same rule the built-in open-in-app
 * package follows for its `./shared` subpath.
 *
 * The paths sit under `/plugins/dsh-open-workspace-any-app/...`, a prefix no
 * other route occupies: the built-in `open-in-app` routes keep
 * `/open-in-app/*`, and `dsh-client-modules` owns the `/plugins` prefix but
 * answers only its own revisioned bundle URLs, so these exact paths are free.
 * @module dsh-open-workspace-any-app/shared
 */

/** Plugin id: the loader row id, the client bundle id, and the route namespace. */
export const PLUGIN_ID = 'dsh-open-workspace-any-app';

/** Route namespace every route of this plugin lives under. */
export const ROUTE_BASE = `/plugins/${PLUGIN_ID}`;

/** GET: the apps this host resolved, in menu order. */
export const APPS_PATH = `${ROUTE_BASE}/apps`;

/** GET prefix: one icon per resolved app id (`{ICON_PREFIX_PATH}/<id>`). */
export const ICON_PREFIX_PATH = `${ROUTE_BASE}/icon`;

/** POST: launch one declared app on one workspace directory. */
export const OPEN_PATH = `${ROUTE_BASE}/open`;

/** GET: installed applications this host detects but does not yet offer. */
export const DISCOVER_PATH = `${ROUTE_BASE}/discover`;

/** POST: add one application to the user's own list. */
export const ADD_PATH = `${ROUTE_BASE}/apps/add`;

/** POST: remove one application from the menu, from either source. */
export const REMOVE_PATH = `${ROUTE_BASE}/apps/remove`;

/** POST: put one removed application back in the menu. */
export const RESTORE_PATH = `${ROUTE_BASE}/apps/restore`;

/** LocalStorage key the browser half remembers the last chosen app under. */
export const CHOICE_STORAGE_KEY = 'dsh.open-workspace-any-app.choice';

/**
 * Browser-relative form of a host pathname.
 *
 * App-owned browser routes are document-relative, so the browser addresses
 * these routes without the leading slash while the Host registers them with
 * it. Stripping happens here, once, at the boundary between the halves.
 * @param {string} path - absolute route pathname (leading slash).
 * @returns the document-relative reference.
 */
export function browserRoute(path) {
  return path.slice(1);
}

/** Apps route reference. */
export const APPS_ROUTE = browserRoute(APPS_PATH);

/** Icon route reference; append `/<id>`. */
export const ICON_ROUTE = browserRoute(ICON_PREFIX_PATH);

/** Launch route reference. */
export const OPEN_ROUTE = browserRoute(OPEN_PATH);

/** Discover route reference. */
export const DISCOVER_ROUTE = browserRoute(DISCOVER_PATH);

/** Add route reference. */
export const ADD_ROUTE = browserRoute(ADD_PATH);

/** Remove route reference. */
export const REMOVE_ROUTE = browserRoute(REMOVE_PATH);

/** Restore route reference. */
export const RESTORE_ROUTE = browserRoute(RESTORE_PATH);

/** Where an offered application came from. */
export const APP_SOURCES = /** @type {const} */ (['declared', 'added']);

/**
 * @typedef {object} AppSummary
 * @property {string} id - stable id from the configuration entry or the store.
 * @property {string} label - label the menu shows.
 * @property {'declared'|'added'} source - whether the operator declared it or the UI added it.
 * @property {boolean} icon - whether the host serves an icon for this id.
 */

/**
 * @typedef {object} AppsResponse
 * @property {AppSummary[]} apps - resolved apps in menu order.
 * @property {Array<{id: string, label: string}>} [hidden] - apps the person removed, restorable.
 * @property {boolean} [truncated] - true when the resolution pass hit its time budget.
 */

/**
 * @typedef {object} DiscoverCandidate
 * @property {string} path - absolute bundle path.
 * @property {string} label - display name derived from the bundle.
 */

/**
 * @typedef {object} DiscoverResponse
 * @property {DiscoverCandidate[]} candidates - installed bundles not yet offered.
 * @property {boolean} [truncated] - true when the scan stopped at its bound.
 */
