/**
 * Host-side configuration schema and the entry grammar it validates.
 *
 * The whole point of this plugin is that the application list is *data*, not
 * a compile-time table: DSH ships its own catalog built at build time (see
 * `@deepseek-ai/dsh-host-open-in-app`, whose `OPEN_IN_APP_CATALOG` is not
 * exported and cannot be injected into), so an application the built-in
 * table does not name — Zap, Qoder IDE, HBuilderX, Obsidian — has no menu
 * entry at all. Here the operator declares entries in the profile patch and
 * the host resolves them at runtime.
 *
 * Each entry declares, per platform, an ordered chain of *locators*: the
 * first locator that verifies on this host wins. That mirrors the built-in
 * resolver's model (chain of candidates, first verified wins) without
 * importing anything from it.
 * @module dsh-open-workspace-any-app/config
 */
import z from '@deepseek-ai/schemastery';

/**
 * How a declared entry hands the directory to the application.
 *
 * `open` passes the directory to the platform's own opener by application
 * identity (`open -a <bundle> <dir>` on macOS, `xdg-open <dir>` on Linux,
 * `start` on Windows) — the right form for a GUI bundle. `argv` runs the
 * resolved executable with the directory in its argv — the right form for a
 * launcher CLI such as `qoder`, `idea`, or a bare terminal.
 *
 * The default follows the locator that matched: an `app` bundle opens by
 * identity, every other locator is an executable and runs by argv.
 */
export const LAUNCH_KINDS = ['open', 'argv'];

/** Token a declared argument may carry; it is replaced by the workspace directory. */
export const PATH_TOKEN = '{path}';

/** Bound on any single declared field: a bound keeps one bad patch off the menu. */
const MAX_TEXT = 4096;

const boundedText = () => z.string().max(MAX_TEXT);

/** One declared launch candidate, tagged by the locator kind it belongs to. */
const LocatorSchema = z.union([
  /** An application bundle (macOS) / executable path (elsewhere), found by absolute path. */
  z.object({
    kind: z.const('app').required(),
    /** Absolute paths tried in order; the first existing bundle wins. */
    paths: z.array(boundedText()).min(1).required(),
    args: z.array(boundedText()).default([]),
  }),
  /** A PATH command resolved through the composition's subprocess capability. */
  z.object({
    kind: z.const('cli').required(),
    command: boundedText().required(),
    args: z.array(boundedText()).default([]),
  }),
  /** An executable at an absolute path. */
  z.object({
    kind: z.const('file').required(),
    paths: z.array(boundedText()).min(1).required(),
    args: z.array(boundedText()).default([]),
  }),
  /** A Windows `App Paths` registry entry verified through the executable it names. */
  z.object({
    kind: z.const('app-paths').required(),
    exe: boundedText().required(),
    args: z.array(boundedText()).default([]),
  }),
]);

/** One declared application: identity, presentation, and its per-platform locator chains. */
const AppSchema = z.object({
  /** Stable id: the launch request and the icon URL address the app by it. */
  id: z.string().pattern(/^[A-Za-z0-9][A-Za-z0-9._-]*$/).max(64).required(),
  /** Label the menu shows. Falls back to the id. */
  label: boundedText(),
  /** Bundle path whose `.icns` supplies the menu icon (macOS); icons are optional. */
  iconBundle: boundedText(),
  /** Absolute path of a PNG/JPEG/SVG/ICNS icon file served as-is. */
  iconPath: boundedText(),
  /** Locators tried in order on this platform. */
  locators: z.array(LocatorSchema).default([]),
  /** Per-platform overrides keyed by `process.platform`. */
  platforms: z.dict(z.array(LocatorSchema)).default({}),
  /** Launch form; defaults by the locator kind that matched (see {@link LAUNCH_KINDS}). */
  launch: z.union(LAUNCH_KINDS.map((kind) => z.const(kind))),
});

/** The plugin's configuration: the declared catalog plus resolution bounds. */
export const Config = z.object({
  /** Declared applications, in menu order. */
  apps: z.array(AppSchema).default([]),
  /** Per-locator deadline for resolution host commands. */
  probeTimeoutMs: z.number().step(1).min(1).max(600_000).default(10_000),
  /** Per-command deadline for icon extraction. */
  iconTimeoutMs: z.number().step(1).min(1).max(600_000).default(10_000),
  /** Early-failure watch window per launch. */
  launchWatchMs: z.number().step(1).min(1).max(600_000).default(1_000),
  /** Ceiling on one resolution pass; a slow pass reports what it has. */
  resolveBudgetMs: z.number().step(1).min(1).max(600_000).default(15_000),
  /**
   * Directory holding the UI-added application store.
   *
   * Defaults to `<DSH home>/open-workspace-any-app`. Overridable so a test (or
   * a second harness home) can keep its additions out of the operator's real
   * `~/.dsh` tree.
   */
  storeDir: z.string().max(4096),
});

/**
 * The locator chain for one app on one platform: an explicit `platforms`
 * entry replaces the shared `locators` chain (a platform that declares its
 * own chain means it, including "none"), matching how the built-in catalog
 * treats a per-platform spec as the whole answer for that platform.
 * @param app - declared application entry.
 * @param platform - `process.platform` value.
 * @returns the chain to resolve, possibly empty.
 */
export function locatorsFor(app, platform) {
  const override = app.platforms?.[platform];
  return override ?? app.locators ?? [];
}

/**
 * Reject duplicate ids at composition time.
 *
 * The menu, the icon route, and the launch route all address an app by id, so
 * two entries sharing one id make the second unreachable while looking
 * configured. Failing loud at apply() turns that into a startup diagnostic
 * instead of a silent half-working menu.
 * @param apps - declared entries.
 * @throws {Error} when two entries share an id.
 */
export function assertUniqueIds(apps) {
  const seen = new Set();
  for (const app of apps) {
    if (seen.has(app.id)) throw new Error(`dsh-open-workspace-any-app: duplicate app id "${app.id}" in config.apps`);
    seen.add(app.id);
  }
}

/**
 * Merge the operator-declared catalog with what the person changed in the UI.
 *
 * Three inputs, applied in this order:
 *
 * 1. `config.apps` — hand-written entries, in menu order, always first.
 * 2. `stored.apps` — applications the UI added, appended in the order added.
 * 3. `stored.hidden` — ids to drop from the menu, from either source.
 *
 * Hiding rather than editing means a removal never touches the operator's
 * document, and it applies uniformly: an app the profile ships declared is as
 * removable as one the UI added, which is the whole point. A hidden id that
 * no source offers is harmless and simply forgotten on the next rebuild.
 *
 * An added entry becomes an ordinary catalog entry whose only locator is the
 * bundle path the person chose, so it resolves, launches, and serves an icon
 * through exactly the same code path as a declared one.
 * @param {object} config - validated plugin configuration.
 * @param {{apps: Array<object>, hidden: string[]}} stored - the UI's additions and removals.
 * @param {string} platform - `process.platform` value.
 * @returns {Array<object>} the merged catalog in menu order.
 */
export function mergeCatalog(config, stored, platform) {
  return fullCatalog(config, stored, platform).filter((app) => !(stored.hidden ?? []).includes(app.id));
}

/**
 * The catalog with removals ignored: every app either source offers.
 *
 * {@link mergeCatalog} filters this by the hidden list, and the manage dialog
 * diffs it against the visible catalog to show what can be restored — one
 * composition, so "what is visible" and "what was removed" can never disagree.
 * @param {object} config - validated plugin configuration.
 * @param {{apps: Array<object>}} stored - the UI's additions.
 * @param {string} platform - `process.platform` value.
 * @returns {Array<object>} every offered application, in menu order.
 */
export function fullCatalog(config, stored, platform) {
  const declared = config.apps ?? [];
  const declaredIds = new Set(declared.map((app) => app.id));
  const declaredPaths = new Set(
    declared.flatMap((app) => (app.locators ?? []).flatMap((locator) => locator.paths ?? [])),
  );
  const added = (stored.apps ?? [])
    // A stored entry the operator later declared by hand is already in the
    // menu; adding it again would offer the same bundle twice.
    .filter((entry) => !declaredIds.has(entry.id) && !declaredPaths.has(entry.path))
    .map((entry) => ({
      id: entry.id,
      label: entry.label,
      source: 'added',
      locators: [{ kind: 'app', paths: [entry.path], args: [] }],
      platforms: {},
      // `open` hands a bundle to the platform launcher by identity, which is
      // what a GUI bundle wants; elsewhere the bundle path is not executable,
      // so the resolved path is run directly.
      launch: platform === 'darwin' || platform === 'win32' ? 'open' : 'argv',
    }));
  return [
    ...declared.map((app) => ({ ...app, source: 'declared' })),
    ...added,
  ];
}

/**
 * The applications the menu is currently hiding, in menu order.
 *
 * The manage dialog lists these so a removal is reversible: dropping an entry
 * with no way back would make a mis-click permanent short of hand-editing the
 * store file.
 * @param {object} config - validated plugin configuration.
 * @param {{apps: Array<object>, hidden: string[]}} stored - the UI's additions and removals.
 * @param {string} platform - `process.platform` value.
 * @returns {Array<{id: string, label: string}>} the hidden applications.
 */
export function hiddenApps(config, stored, platform) {
  const visible = new Set(mergeCatalog(config, stored, platform).map((app) => app.id));
  return fullCatalog(config, stored, platform)
    .filter((app) => !visible.has(app.id))
    .map((app) => ({ id: app.id, label: app.label ?? app.id }));
}
