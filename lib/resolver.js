/**
 * Resolution and launch for the declared application catalog.
 *
 * Resolution mirrors the built-in `open-in-app` resolver's *model* — an
 * ordered locator chain whose first verified candidate wins, resolved once
 * per plugin life into a map the routes serve and launch from — but shares no
 * code with it: that package keeps its catalog, resolver, and test seams
 * module-private (`lib/types/internals.js` holds `{ catalog: {} }` and is not
 * reachable through the package's `exports`), which is exactly why an
 * application the built-in table does not name has no built-in menu entry and
 * why this plugin resolves its own declared entries instead.
 *
 * Every host fact arrives as an injected seam ({@link ResolutionFacts}), so
 * the rules here are testable without a running composition: no `process`, no
 * `homedir()`, no real `spawn` is reached except through the defaults
 * `index.js` assembles.
 * @module dsh-open-workspace-any-app/resolver
 */
import { PATH_TOKEN } from './config.js';

/**
 * @typedef {object} ResolutionFacts
 * @property {string} platform - `process.platform` value.
 * @property {NodeJS.ProcessEnv} env - environment for `${VAR}` expansion.
 * @property {string} home - home directory for `~/` expansion.
 * @property {(path: string) => Promise<boolean>} isDirectory - directory probe.
 * @property {(path: string) => Promise<boolean>} isFile - regular-file probe.
 * @property {(name: string) => Promise<string|null>} resolveExecutable - PATH lookup; null when absent.
 * @property {(command: string, args: string[], timeoutMs: number) => Promise<string|null>} run - bounded host command; null on any failure.
 * @property {(command: string, args: string[], watchMs: number) => Promise<void>} launch - detached launch; rejects on early failure.
 * @property {() => number} now - monotonic millisecond clock for the pass budget.
 */

/**
 * @typedef {object} ResolvedLaunch
 * @property {string} appId - the app this resolved for.
 * @property {'open'|'argv'} kind - the launch form to use.
 * @property {string} target - bundle path (open) or executable (argv).
 * @property {string[]} args - declared args, `{path}` tokens unsubstituted.
 * @property {string|null} iconPath - declared icon file, when it exists.
 * @property {string|null} iconBundle - bundle whose `.icns` supplies the icon.
 */

/**
 * Expand `~/` and `${VAR}` in a declared path.
 * @param {string} template - declared path.
 * @param {ResolutionFacts} facts - resolution seams.
 * @returns {string|null} the expanded path, or null when a referenced variable is unset.
 */
export function expandPath(template, facts) {
  const unset = [];
  const expanded = template.replace(/\$\{([^}]+)\}/g, (token, name) => {
    const value = facts.env[name];
    if (value === undefined) unset.push(name);
    return value ?? token;
  });
  if (unset.length > 0) return null;
  if (expanded === '~') return facts.home;
  return expanded.startsWith('~/') ? `${facts.home}/${expanded.slice(2)}` : expanded;
}

/**
 * Run one bounded host command through the injected runner.
 * @param {ResolutionFacts} facts - resolution seams.
 * @param {string} command - executable path or PATH name.
 * @param {string[]} args - argv, never a shell string.
 * @param {number} timeoutMs - command deadline.
 * @returns {Promise<string|null>} stdout on exit 0; null on any failure.
 */
async function output(facts, command, args, timeoutMs) {
  try {
    return await facts.run(command, args, timeoutMs);
  } catch {
    // Swallows spawn failures, non-zero exits, and timeouts alike: for
    // detection a failed host command has exactly one meaning — unavailable.
    return null;
  }
}

/**
 * Substitute the workspace directory into a declared argv.
 *
 * A declared arg carrying `{path}` decides where the directory goes; with no
 * such token the directory is appended, which is what an editor CLI wants.
 * @param {string[]} args - declared args.
 * @param {string} path - workspace directory.
 * @returns {string[]} argv for the launcher.
 */
export function launchArgs(args, path) {
  return args.some((arg) => arg.includes(PATH_TOKEN))
    ? args.map((arg) => arg.split(PATH_TOKEN).join(path))
    : [...args, path];
}

/**
 * Resolve one locator to a verified launcher target.
 *
 * `openPath` is the launcher identity for the `open` form — a macOS bundle
 * for an `app` locator — while `target` is what the `argv` form runs. An
 * `app` locator reports both: bundle path and its `Contents/MacOS/<exe>`
 * is *not* assumed, because a bundle launched directly bypasses
 * LaunchServices and loses the single-instance behavior an editor relies on.
 * @param {object} locator - one declared locator.
 * @param {ResolutionFacts} facts - resolution seams.
 * @param {number} probeTimeoutMs - per-command deadline.
 * @returns {Promise<{target: string, openTarget: string|null}|null>} the verified launcher, or null.
 */
async function locate(locator, facts, probeTimeoutMs) {
  switch (locator.kind) {
    case 'app': {
      for (const candidate of locator.paths) {
        const expanded = expandPath(candidate, facts);
        if (expanded !== null && (await facts.isDirectory(expanded))) {
          return { target: expanded, openTarget: expanded };
        }
      }
      return null;
    }
    case 'file': {
      for (const candidate of locator.paths) {
        const expanded = expandPath(candidate, facts);
        if (expanded !== null && (await facts.isFile(expanded))) return { target: expanded, openTarget: null };
      }
      return null;
    }
    case 'cli': {
      const found = await facts.resolveExecutable(locator.command);
      return found === null ? null : { target: found, openTarget: null };
    }
    case 'app-paths': {
      // `App Paths` lives in the registry; the user hive shadows the machine
      // hive for per-user installs, so it is asked first.
      for (const root of [
        'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths',
        'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths',
      ]) {
        const stdout = await output(facts, 'reg.exe', ['query', `${root}\\${locator.exe}`, '/ve'], probeTimeoutMs);
        if (stdout === null) continue;
        const match = /REG_(?:SZ|EXPAND_SZ)\s+(.+)/.exec(stdout);
        if (match === null) continue;
        const target = match[1].trim().replace(/^"|"$/g, '');
        if (await facts.isFile(target)) return { target, openTarget: null };
      }
      return null;
    }
    /* c8 ignore next 2 -- the Config schema admits only the kinds above */
    default:
      return null;
  }
}

/**
 * Resolve one declared app on this host: its platform's locator chain is
 * tried in order and the first verified launcher wins.
 * @param {object} app - declared app entry.
 * @param {import('./config.js').Config} config - plugin configuration.
 * @param {ResolutionFacts} facts - resolution seams.
 * @returns {Promise<ResolvedLaunch|null>} the launcher, or null when this host has none.
 */
export async function resolveApp(app, config, facts) {
  const override = (app.platforms ?? {})[facts.platform];
  const chain = override ?? app.locators ?? [];
  for (const locator of chain) {
    const found = await locate(locator, facts, config.probeTimeoutMs);
    if (found === null) continue;
    const iconPath = app.iconPath == null ? null : expandPath(app.iconPath, facts);
    return {
      appId: app.id,
      // An `app` bundle opens by identity; every other locator is an
      // executable, which only the argv form can use.
      kind: app.launch ?? (locator.kind === 'app' ? 'open' : 'argv'),
      target: found.target,
      args: locator.args ?? [],
      iconPath,
      iconBundle: app.iconBundle == null
        ? found.openTarget !== null && facts.platform === 'darwin' ? found.target : null
        : expandPath(app.iconBundle, facts),
    };
  }
  return null;
}

/**
 * Resolve every declared app, in declared menu order.
 *
 * One pass, run lazily on the first request that needs it: an app that does
 * not resolve on this host is absent from the map, so the menu offers only
 * what is actually installed. The pass runs under `config.resolveBudgetMs`
 * and each entry also carries its own deadline, so one hanging locator
 * cannot hold the whole menu: entries still unresolved when the budget
 * expires are reported through `truncated` instead of silently missing.
 * @param {import('./config.js').Config} config - plugin configuration.
 * @param {ResolutionFacts} facts - resolution seams.
 * @returns {Promise<{launches: Map<string, ResolvedLaunch>, truncated: boolean}>} the pass result.
 */
export async function resolveCatalog(config, facts) {
  const budget = config.resolveBudgetMs;
  const deadline = facts.now() + budget;
  let timedOut = false;

  const jobs = config.apps.map(async (app) => {
    try {
      const remaining = deadline - facts.now();
      if (remaining <= 0) {
        timedOut = true;
        return [app.id, null];
      }
      // The entry's own deadline is whichever is closer: its locator probe
      // bound or the shared pass budget.
      const raced = await Promise.race([
        resolveApp(app, config, facts),
        new Promise((resolve) => {
          const timer = setTimeout(() => {
            timedOut = true;
            resolve(null);
          }, remaining);
          // A pass that finishes first must not keep the process alive.
          timer.unref?.();
        }),
      ]);
      return [app.id, raced];
    } catch {
      // One malformed entry (an unreadable path, a throwing seam) must not
      // take the menu down: it resolves as absent, like an uninstalled app.
      return [app.id, null];
    }
  });

  const settled = await Promise.all(jobs);
  const launches = new Map();
  for (const [id, launch] of settled) {
    if (launch !== null) launches.set(id, launch);
  }
  return { launches, truncated: timedOut };
}

/**
 * Launch one resolved application on one directory.
 *
 * `open` hands the directory to the platform's own opener by application
 * identity; `argv` runs the resolved executable with the directory in its
 * argv. Both report failure only from the watch window: a launcher still
 * running when the window closes counts as launched and keeps running,
 * because GUI editors stay in the foreground for their whole window
 * lifetime — the same rule the built-in launcher follows.
 * @param {ResolvedLaunch} resolved - a verified launcher.
 * @param {string} path - absolute workspace directory.
 * @param {number} watchMs - early-failure watch window.
 * @param {ResolutionFacts} facts - resolution seams.
 * @returns {Promise<'launched'|'failed'>} how the attempt ended.
 */
export async function launchResolved(resolved, path, watchMs, facts) {
  const args = launchArgs(resolved.args, path);
  try {
    if (resolved.kind === 'open') {
      if (facts.platform === 'darwin') {
        // `open -a <bundle> <dir>`: LaunchServices resolves the bundle, so a
        // running instance is reused instead of a second one spawned.
        await facts.launch('open', ['-a', resolved.target, path], watchMs);
      } else if (facts.platform === 'win32') {
        // `start` is a cmd builtin; the empty title arg keeps a quoted path
        // from being read as the window title.
        await facts.launch('cmd', ['/c', 'start', '', resolved.target, path], watchMs);
      } else {
        await facts.launch('xdg-open', [path], watchMs);
      }
      return 'launched';
    }
    await facts.launch(resolved.target, args, watchMs);
    return 'launched';
  } catch {
    return 'failed';
  }
}
