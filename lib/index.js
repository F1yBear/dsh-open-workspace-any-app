/**
 * Host half of `dsh-open-workspace-any-app`: the declared application
 * catalog, its icons, and the launch endpoint, as three routes on the
 * composition's `webServer`.
 *
 * ## Why this plugin exists
 *
 * The shipped `@deepseek-ai/dsh-host-open-in-app` resolves a *build-time*
 * catalog: `OPEN_IN_APP_CATALOG` is a module-level constant the package does
 * not export, its resolver reads host facts through a module-private `internals`
 * seam that production leaves empty, and its `Config` admits only three timeout
 * fields. So an application the shipped table does not name — Zap, Qoder IDE,
 * HBuilderX, Obsidian — cannot be added by configuration, and no plugin can
 * extend that table from outside. What a plugin *can* do is mount its own
 * routes beside the built-in ones and register its own cell in the Session
 * header, which is what this package does. The two controls sit side by side;
 * neither shadows the other, and the built-in `(kind, path)` route table would
 * reject a duplicate path anyway.
 *
 * ## Route ownership
 *
 * All three paths live under `/plugins/dsh-open-workspace-any-app/...`, which
 * no other route claims: the built-in control owns `/open-in-app/*`, and
 * `dsh-client-modules` owns the `/plugins` prefix but matches only its own
 * revisioned bundle URLs. Exact paths win over the prefix table, so these
 * routes are reachable without disturbing bundle serving.
 *
 * ## Security
 *
 * Every route asks the composition's `connection` service for a rejection
 * first (`requestRejection`), exactly as the built-in control does: that fence
 * enforces the Host/Origin check that defeats DNS rebinding and requires the
 * browser's authentication before any catalog, icon, or launch is reachable.
 * On top of the fence the launch route validates its body at the wire —
 * `application/json`, a 64 KiB ceiling, string `app`/`path` fields, a resolved
 * id, and an absolute path naming an existing directory — so an untrusted
 * caller can never turn the route into "run this path".
 *
 * ## Dependency surface
 *
 * This package imports exactly one host dependency, `@deepseek-ai/schemastery`
 * (for the `Config` schema), and reaches every other host capability through
 * the cordis context: `webServer`, `connection`, and `subprocess`. That is
 * deliberate. A plugin resolves `@deepseek-ai/*` from the profile it is
 * installed into, which need not be the tree the running application booted
 * from — the two can be different releases — so every additional cross-package
 * import is another chance for a version skew to break the plugin on import.
 * The two capabilities this plugin would otherwise have imported are therefore
 * implemented here, in the few lines they need: environment scrubbing for
 * detached launches ({@link scrubbedParentEnv}) and SSH detection
 * ({@link launchedThroughSsh}).
 * @module dsh-open-workspace-any-app
 */
import { execFile, spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { Config, assertUniqueIds, hiddenApps, mergeCatalog } from './config.js';
import { APPLICATION_ROOTS, discoverApps } from './discover.js';
import { extractAppIcon, ICON_CACHE_CONTROL } from './icons.js';
import { launchResolved, resolveCatalog } from './resolver.js';
import { addUserApp, readStore, removeUserApp, restoreUserApp, slugify, storePath, uniqueId, writeStore } from './store.js';
import {
  ADD_PATH,
  APPS_PATH,
  DISCOVER_PATH,
  ICON_PREFIX_PATH,
  OPEN_PATH,
  PLUGIN_ID,
  REMOVE_PATH,
  RESTORE_PATH,
} from './shared.js';

export { Config };

/** Cordis function-plugin name: the loader row id and the route namespace. */
export const name = PLUGIN_ID;

/**
 * The route carrier, the trust fence, and the PATH resolver.
 *
 * `connection` is required, not optional: it owns the trust fence every route
 * here depends on, and a composition that mounts this plugin without it would
 * otherwise expose an unfenced "launch a local application" endpoint. The
 * shipped open-in-app control requires the same three services.
 */
export const inject = ['webServer', 'connection', 'subprocess'];

/** Open-route bodies are tiny JSON objects; anything larger is hostile. */
const MAX_BODY_BYTES = 64 * 1024;

/**
 * Environment names whose values must never reach a launched application: a
 * launch is a user-facing action, not a reason to hand an editor the
 * harness's credentials.
 */
const SENSITIVE_ENV_PATTERN = /KEY|PASSWORD|SECRET|TOKEN/i;

/**
 * The current environment minus credentials, `DSH_*` internals, and
 * `NODE_OPTIONS`/`NODE_PATH` (which would otherwise let a child inherit the
 * harness's own loader configuration).
 * @returns {Record<string, string>} the scrubbed environment.
 */
export function scrubbedParentEnv() {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (SENSITIVE_ENV_PATTERN.test(key)) continue;
    const upper = key.toUpperCase();
    if (upper.startsWith('DSH_') || upper === 'NODE_OPTIONS' || upper === 'NODE_PATH') continue;
    env[key] = value;
  }
  return env;
}

/**
 * Whether this host was launched over SSH.
 *
 * A remote session has no local GUI to open into, so the catalog resolves as
 * empty rather than probing for applications that could not be shown.
 * @param {Record<string, string|undefined>} env - environment to inspect.
 * @returns {boolean} true when either SSH marker is present and non-empty.
 */
export function launchedThroughSsh(env) {
  return ['SSH_CONNECTION', 'SSH_TTY'].some((key) => {
    const value = env[key];
    return value !== undefined && value !== '';
  });
}

/**
 * JSON response. `no-store` because availability and launch outcomes are live
 * facts: a cached app list would keep offering an app the user just removed.
 * @param {import('node:http').ServerResponse} res - response.
 * @param {number} status - status code.
 * @param {unknown} payload - JSON payload.
 */
function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(payload));
}

/**
 * 405 with the route's one supported method.
 * @param {import('node:http').ServerResponse} res - response.
 * @param {string} allow - the allowed method.
 */
function sendMethodNotAllowed(res, allow) {
  res.statusCode = 405;
  res.setHeader('allow', allow);
  res.end();
}

/**
 * Collect a bounded request body as UTF-8 text.
 * @param {import('node:http').IncomingMessage} req - request.
 * @returns {Promise<string|null>} the body, or null past the ceiling (stream drained).
 */
async function readBoundedBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.byteLength;
    if (size > MAX_BODY_BYTES) {
      // Drain the remainder so the refusal is a readable response, not a socket cut.
      req.resume();
      return null;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size).toString('utf8');
}

/**
 * The application roots the add-application dialog scans.
 *
 * `APPLICATION_ROOTS` covers the machine-wide locations; the user's own
 * `~/Applications` is appended because a per-user install lives there and is
 * otherwise invisible to the scan.
 * @returns {string[]} absolute directories to scan.
 */
function discoverRoots() {
  return [...APPLICATION_ROOTS, join(homedir(), 'Applications')];
}

/**
 * Read and validate a JSON request body.
 *
 * Answers the request itself on any failure — wrong method, wrong media type,
 * oversized body, malformed JSON, or a missing/blank required field — so each
 * route's body is only ever reached with validated strings.
 *
 * `optional` fields are carried through when the caller supplied a non-blank
 * string and dropped otherwise. They must be declared rather than read off the
 * raw body: a route that forwards an undeclared field is one typo away from
 * letting the wire choose a value the schema never agreed to.
 * @param {import('node:http').IncomingMessage} req - request.
 * @param {import('node:http').ServerResponse} res - response.
 * @param {string[]} fields - required string field names.
 * @param {string[]} [optional] - optional string field names.
 * @returns {Promise<Record<string, string>|null>} the fields, or null when the request was answered.
 */
async function readJsonBody(req, res, fields, optional = []) {
  if (req.method !== 'POST') {
    sendMethodNotAllowed(res, 'POST');
    return null;
  }
  // Body-format validation: the essence must be exactly application/json.
  // String(undefined) is 'undefined', which never matches.
  const essence = String(req.headers['content-type']).split(';', 1)[0]?.trim().toLowerCase();
  if (essence !== 'application/json') {
    sendJson(res, 415, { code: 'unsupported-media-type', message: 'content-type must be application/json' });
    return null;
  }
  let text;
  try {
    text = await readBoundedBody(req);
  } catch {
    // Swallows mid-body connection errors: there is nothing left to answer precisely.
    sendJson(res, 400, { code: 'bad-request', message: 'request body unreadable' });
    return null;
  }
  if (text === null) {
    sendJson(res, 413, { code: 'payload-too-large', message: 'request body is too large' });
    return null;
  }
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    sendJson(res, 400, { code: 'bad-request', message: 'request body must be JSON' });
    return null;
  }
  if (typeof body !== 'object' || body === null) {
    sendJson(res, 400, { code: 'bad-request', message: 'request body must be a JSON object' });
    return null;
  }
  const out = {};
  for (const field of fields) {
    const value = body[field];
    // A blank value is refused here rather than stored: an empty path or id
    // would produce an entry that resolves to nothing.
    if (typeof value !== 'string' || value === '') {
      sendJson(res, 400, { code: 'bad-request', message: `"${field}" must be a non-empty string` });
      return null;
    }
    out[field] = value;
  }
  for (const field of optional) {
    const value = body[field];
    // An optional field is absent or blank far more often than it is wrong:
    // the native chooser returns a path and nothing else, so the label is
    // omitted on the common path and must not be an error when it is.
    if (typeof value === 'string' && value !== '') out[field] = value;
  }
  return out;
}

/**
 * Launch one application detached from this process.
 *
 * The child gets a credential-scrubbed environment, holds no stdio pipe, and
 * outlives dsh. A child still running when the watch window closes is unrefed
 * and counted launched — an editor stays in the foreground for its whole
 * window lifetime — so only a spawn failure or a nonzero exit *inside* the
 * window rejects.
 * @param {string} command - executable path or PATH name.
 * @param {string[]} args - argv, never a shell string.
 * @param {number} watchMs - early-failure watch window.
 * @returns {Promise<void>} resolves once the launch counts as successful.
 */
export function launchDetached(command, args, watchMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      detached: true,
      stdio: 'ignore',
      env: scrubbedParentEnv(),
    });
    let settled = false;
    let watch;
    const settle = (outcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(watch);
      child.unref();
      outcome();
    };
    watch = setTimeout(() => {
      settle(resolve);
    }, watchMs);
    child.on('error', (error) => {
      settle(() => {
        reject(error);
      });
    });
    child.on('exit', (code, signalName) => {
      if (code === 0) settle(resolve);
      else settle(() => reject(new Error(`launcher exited with code ${String(code)}, signal ${String(signalName)}`)));
    });
  });
}

/**
 * Run one bounded host command and return its stdout.
 * @param {string} command - executable path or PATH name.
 * @param {string[]} args - argv, never a shell string.
 * @param {number} timeoutMs - command deadline.
 * @returns {Promise<string|null>} stdout, or null on any failure.
 */
function runBounded(command, args, timeoutMs) {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: timeoutMs, encoding: 'utf8', windowsHide: true }, (error, stdout) => {
      resolve(error === null || error === undefined ? stdout : null);
    });
  });
}

/**
 * Register the apps, icon, and launch routes.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {import('./config.js').Config} config - validated plugin configuration.
 */
export function apply(ctx, config) {
  assertUniqueIds(config.apps);

  /** Host facts and process adapters, all reached through the composition. */
  const facts = {
    platform: process.platform,
    env: process.env,
    home: homedir(),
    now: () => Date.now(),
    isDirectory: async (path) => {
      try {
        return (await stat(path)).isDirectory();
      } catch {
        // Swallows ENOENT/EACCES: an unreadable candidate is not an application.
        return false;
      }
    },
    isFile: async (path) => {
      try {
        return (await stat(path)).isFile();
      } catch {
        return false;
      }
    },
    /** PATH resolution through the composition's subprocess capability. */
    resolveExecutable: async (commandName) => {
      try {
        return await ctx.subprocess.resolveExecutable(commandName);
      } catch {
        // Swallows the provider's not-found rejection: for detection, a name
        // that does not resolve has exactly one meaning — unavailable.
        return null;
      }
    },
    /** Bounded host command for Windows registry lookups; argv only, never a shell. */
    run: async (command, args, timeoutMs) => {
      // Only `reg.exe` is ever a locator's command; anything else would be a
      // schema bypass rather than a lookup.
      if (command !== 'reg.exe') return null;
      return await runBounded(command, args, timeoutMs);
    },
    launch: launchDetached,
  };

  /**
   * The catalog is the operator's declared entries merged with the entries the
   * UI added, and it is re-resolved whenever either side changes: an addition
   * must appear in the menu without restarting DSH.
   *
   * The *promise* is cached, not just the result: the menu fetches the catalog
   * and then an icon per row, so several requests race the first resolution,
   * and caching only the result would start one detection pass per racer.
   */
  let truncated = false;
  let entries = [];
  /** Applications the person removed; the manage dialog offers them back. */
  let hidden = [];
  let availability;

  // `config.storeDir` keeps a test or a second harness home out of the
  // operator's real `~/.dsh` tree; production leaves it unset.
  const storeFile = storePath(process.env, homedir(), config.storeDir);

  /** Per-app icon promise cache (null = resolved as unavailable). */
  const icons = new Map();

  /**
   * A mutation rebuilds the catalog, and the request that performed it must
   * not answer before the rebuild lands; requests that merely read wait on
   * whichever rebuild is current.
   */
  let ready = Promise.resolve();

  /**
   * Re-read the user store, rebuild the merged catalog, and start a fresh
   * resolution pass. Called at apply() and after every mutation.
   * @returns {Promise<void>} resolves once the new pass is installed.
   */
  const reload = async () => {
    const stored = await readStore(storeFile);
    hidden = hiddenApps(config, stored, process.platform);
    entries = mergeCatalog(config, stored, process.platform);
    availability = launchedThroughSsh(process.env)
      ? Promise.resolve(new Map())
      // A remote session has no local GUI to open into, so the catalog is
      // empty rather than probed — the same rule the shipped control applies.
      : resolveCatalog({ ...config, apps: entries }, facts).then((pass) => {
        truncated = pass.truncated;
        return pass.launches;
      });
    // Icons are keyed by app id, and an id can be re-added after removal with
    // a different bundle; dropping the cache keeps a stale icon from sticking.
    icons.clear();
    await availability;
  };

  /** Install a rebuild, so readers can await the current one. */
  const rebuild = () => {
    ready = reload();
    return ready;
  };

  /**
   * The resolved catalog, after the current rebuild settles.
   * @returns {Promise<Map<string, object>>} id to verified launcher.
   */
  const catalog = async () => {
    await ready;
    return availability;
  };

  /** One app's icon, extracted at most once per plugin life. */
  const iconOf = (resolved) => {
    let cached = icons.get(resolved.appId);
    if (cached === undefined) {
      cached = extractAppIcon(resolved, config.iconTimeoutMs);
      icons.set(resolved.appId, cached);
    }
    return cached;
  };

  /**
   * Answer an untrusted or unauthenticated request; true when it was rejected.
   *
   * The `connection` service is injected, so in a web composition the fence is
   * always present; this guard keeps a hand-built context from serving these
   * routes unfenced, where any page the browser loads could drive local
   * application launches.
   * @param {import('node:http').IncomingMessage} req - request.
   * @param {import('node:http').ServerResponse} res - response.
   * @returns {boolean} whether the request was rejected.
   */
  const rejected = (req, res) => {
    const connection = ctx.connection;
    if (connection === undefined) {
      res.statusCode = 503;
      res.end();
      return true;
    }
    const rejection = connection.requestRejection(req);
    if (rejection === undefined) return false;
    res.statusCode = rejection;
    res.end();
    return true;
  };

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: APPS_PATH,
    handler: async (req, res) => {
      if (rejected(req, res)) return;
      if (req.method !== 'GET') {
        sendMethodNotAllowed(res, 'GET');
        return;
      }
      const launches = await catalog();
      sendJson(res, 200, {
        apps: [...launches.keys()].map((id) => {
          const resolved = launches.get(id);
          const entry = entries.find((app) => app.id === id);
          return {
            id,
            label: entry?.label ?? id,
            // `source` lets the dialog show which entries the operator declared
            // (not removable here) and which the UI added (removable).
            source: entry?.source === 'added' ? 'added' : 'declared',
            // The browser appends the id itself; a bare prefix keeps the two
            // halves from disagreeing about URL shape.
            icon: resolved.iconPath !== null || resolved.iconBundle !== null,
          };
        }),
        // Removed apps ride the same response: the dialog needs both lists to
        // show what can be put back, and they are one consistent snapshot.
        ...(hidden.length === 0 ? {} : { hidden: hidden.map((app) => ({ id: app.id, label: app.label })) }),
        ...(truncated ? { truncated: true } : {}),
      });
    },
  }), `dsh-open-workspace-any-app: GET ${APPS_PATH}`);

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: ICON_PREFIX_PATH,
    handler: async (req, res) => {
      if (rejected(req, res)) return;
      if (req.method !== 'GET') {
        sendMethodNotAllowed(res, 'GET');
        return;
      }
      const pathname = new URL(String(req.url), 'http://localhost').pathname;
      const id = pathname.slice(ICON_PREFIX_PATH.length).replace(/^\//, '');
      const noIcon = () => {
        sendJson(res, 404, { code: 'not-found', message: `no icon for ${id}` });
      };
      const resolved = (await catalog()).get(id);
      if (resolved === undefined) {
        noIcon();
        return;
      }
      const icon = await iconOf(resolved);
      if (icon === null) {
        noIcon();
        return;
      }
      res.statusCode = 200;
      res.setHeader('content-type', icon.contentType);
      res.setHeader('cache-control', ICON_CACHE_CONTROL);
      res.end(icon.bytes);
    },
  }), `dsh-open-workspace-any-app: GET ${ICON_PREFIX_PATH}/<id>`);

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: OPEN_PATH,
    handler: async (req, res) => {
      if (rejected(req, res)) return;
      const parsed = await readJsonBody(req, res, ['app', 'path']);
      if (parsed === null) return;
      const resolved = (await catalog()).get(parsed.app);
      if (resolved === undefined) {
        sendJson(res, 400, { code: 'bad-request', message: `unknown or unavailable app: ${parsed.app}` });
        return;
      }
      if (!isAbsolute(parsed.path)) {
        sendJson(res, 400, { code: 'bad-request', message: 'path must be an absolute directory path' });
        return;
      }
      let directory;
      try {
        directory = (await stat(parsed.path)).isDirectory();
      } catch {
        // Swallows ENOENT/EACCES: both mean there is no directory to open.
        directory = false;
      }
      if (!directory) {
        sendJson(res, 404, { code: 'not-found', message: `directory does not exist: ${parsed.path}` });
        return;
      }
      const outcome = await launchResolved(resolved, parsed.path, config.launchWatchMs, facts);
      if (outcome === 'launched') {
        sendJson(res, 200, { ok: true });
      } else {
        sendJson(res, 502, { code: 'launch-failed', message: `failed to launch ${parsed.app}` });
      }
    },
  }), `dsh-open-workspace-any-app: POST ${OPEN_PATH}`);

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: DISCOVER_PATH,
    handler: async (req, res) => {
      if (rejected(req, res)) return;
      if (req.method !== 'GET') {
        sendMethodNotAllowed(res, 'GET');
        return;
      }
      const launches = await catalog();
      // Only *resolved* entries count as offered: a declared app that is not
      // installed here is exactly what the user may be trying to pick.
      const offeredPaths = new Set(
        entries
          .filter((entry) => launches.has(entry.id))
          .flatMap((entry) => (entry.locators ?? []).flatMap((locator) => locator.paths ?? [])),
      );
      const { candidates, truncated: scanTruncated } = await discoverApps({
        roots: discoverRoots(),
        offeredPaths,
      });
      sendJson(res, 200, {
        candidates,
        ...(scanTruncated ? { truncated: true } : {}),
      });
    },
  }), `dsh-open-workspace-any-app: GET ${DISCOVER_PATH}`);

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: ADD_PATH,
    handler: async (req, res) => {
      if (rejected(req, res)) return;
      const parsed = await readJsonBody(req, res, ['path'], ['label']);
      if (parsed === null) return;
      const { path } = parsed;
      // `label` is optional: the native chooser hands back a path, and the
      // bundle's own name is a better default than asking the person to name
      // it twice — so a caller that does supply one keeps it.
      const label = parsed.label ?? labelFromPath(path);
      if (!isAbsolute(path)) {
        sendJson(res, 400, { code: 'bad-request', message: 'path must be an absolute application path' });
        return;
      }
      // The bundle must exist and be a directory: storing a typo would add an
      // entry that resolves to nothing, which then silently never appears.
      let bundle;
      try {
        bundle = (await stat(path)).isDirectory();
      } catch {
        bundle = false;
      }
      if (!bundle) {
        sendJson(res, 404, { code: 'not-found', message: `application bundle does not exist: ${path}` });
        return;
      }
      const stored = await readStore(storeFile);
      const taken = [
        ...entries.map((entry) => entry.id),
        ...stored.apps.map((entry) => entry.id),
        ...hidden.map((entry) => entry.id),
      ];
      const id = uniqueId(slugify(label), taken);
      await writeStore(storeFile, addUserApp(stored, { id, label, path }));
      await rebuild();
      sendJson(res, 200, { ok: true, app: { id, label, source: 'added', icon: true } });
    },
  }), `dsh-open-workspace-any-app: POST ${ADD_PATH}`);

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: REMOVE_PATH,
    handler: async (req, res) => {
      if (rejected(req, res)) return;
      const parsed = await readJsonBody(req, res, ['app']);
      if (parsed === null) return;
      const { app: id } = parsed;
      // Removal applies to the *menu*, not to one source: an app the profile
      // ships declared is as removable as one added here. It is recorded as a
      // removal rather than an edit, so the operator's document is untouched
      // and the action is reversible through the restore route.
      const known = [...entries, ...hidden].some((entry) => entry.id === id);
      if (!known) {
        sendJson(res, 404, { code: 'not-found', message: `no application with id: ${id}` });
        return;
      }
      const stored = await readStore(storeFile);
      await writeStore(storeFile, removeUserApp(stored, id));
      await rebuild();
      sendJson(res, 200, { ok: true });
    },
  }), `dsh-open-workspace-any-app: POST ${REMOVE_PATH}`);

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: RESTORE_PATH,
    handler: async (req, res) => {
      if (rejected(req, res)) return;
      const parsed = await readJsonBody(req, res, ['app']);
      if (parsed === null) return;
      const { app: id } = parsed;
      const stored = await readStore(storeFile);
      if (!stored.hidden.includes(id)) {
        sendJson(res, 404, { code: 'not-found', message: `no removed application with id: ${id}` });
        return;
      }
      await writeStore(storeFile, restoreUserApp(stored, id));
      await rebuild();
      sendJson(res, 200, { ok: true });
    },
  }), `dsh-open-workspace-any-app: POST ${RESTORE_PATH}`);

  // Install the first pass before any route can serve; nothing awaits this
  // promise here, so a failing first pass surfaces per-request instead of
  // failing composition.
  void rebuild();
}

/**
 * The display name a bundle path implies: its file name without `.app`.
 *
 * A scanned candidate already carries its own label, and the dialog passes it
 * through; this fallback covers a caller that names a path alone. A bundle's
 * file name is what Finder shows anyway, so it is the label the person has in
 * mind — asking them to retype it would be the developer-shaped step this
 * flow exists to remove.
 * @param {string} path - absolute bundle path.
 * @returns {string} the label.
 */
function labelFromPath(path) {
  const base = path.replace(/\/+$/u, '').split('/').pop() ?? path;
  return base.endsWith('.app') ? base.slice(0, -4) : base;
}
