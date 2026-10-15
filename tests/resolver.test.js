/**
 * Resolution rules: locator chains, platform overrides, expansion, launch argv.
 *
 * Every host fact is an injected seam, so these tests exercise the real
 * resolution path without a composition, a GUI, or a spawned process.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { PATH_TOKEN } from '../lib/config.js';
import { expandPath, launchArgs, launchResolved, resolveApp, resolveCatalog } from '../lib/resolver.js';

/**
 * Build one fact set with overridable seams.
 * @param {object} [overrides] - seam overrides.
 * @returns {object} a complete facts object.
 */
function facts(overrides = {}) {
  return {
    platform: 'darwin',
    env: { HOME: '/Users/tester' },
    home: '/Users/tester',
    now: () => 1_000,
    isDirectory: async () => false,
    isFile: async () => false,
    resolveExecutable: async () => null,
    run: async () => null,
    launch: async () => {},
    ...overrides,
  };
}

/** One app declaration with a single locator. */
function app(id, locator, extra = {}) {
  return { id, label: id, locators: [locator], platforms: {}, ...extra };
}

/** A config wrapper with test-sized bounds. */
function config(apps, overrides = {}) {
  return { apps, probeTimeoutMs: 100, iconTimeoutMs: 100, launchWatchMs: 20, resolveBudgetMs: 5_000, ...overrides };
}

test('app locator resolves the first existing bundle and opens by identity', async () => {
  const seen = [];
  const resolved = await resolveApp(
    app('zap', { kind: 'app', paths: ['/nope/Zap.app', '/Applications/Zap.app'], args: [] }),
    config([]),
    facts({
      isDirectory: async (path) => {
        seen.push(path);
        return path === '/Applications/Zap.app';
      },
    }),
  );
  assert.deepEqual(seen, ['/nope/Zap.app', '/Applications/Zap.app'], 'candidates are tried in order');
  assert.equal(resolved.target, '/Applications/Zap.app');
  assert.equal(resolved.kind, 'open', 'an app bundle defaults to the open form');
  assert.equal(resolved.iconBundle, '/Applications/Zap.app', 'the bundle supplies its own icon on macOS');
});

test('cli locator runs by argv and yields no bundle icon', async () => {
  const resolved = await resolveApp(
    app('idea', { kind: 'cli', command: 'idea', args: [] }),
    config([]),
    facts({ resolveExecutable: async (name) => (name === 'idea' ? '/usr/local/bin/idea' : null) }),
  );
  assert.equal(resolved.target, '/usr/local/bin/idea');
  assert.equal(resolved.kind, 'argv', 'an executable locator defaults to argv');
  assert.equal(resolved.iconBundle, null);
});

test('a declared launch form overrides the locator default', async () => {
  const resolved = await resolveApp(
    app('zap', { kind: 'app', paths: ['/Applications/Zap.app'], args: [] }, { launch: 'argv' }),
    config([]),
    facts({ isDirectory: async () => true }),
  );
  assert.equal(resolved.kind, 'argv');
});

test('a platform override replaces the shared chain wholesale', async () => {
  const entry = {
    id: 'editor',
    label: 'editor',
    locators: [{ kind: 'app', paths: ['/Applications/Mac.app'], args: [] }],
    platforms: { linux: [{ kind: 'cli', command: 'editor', args: [] }] },
  };
  const onLinux = await resolveApp(entry, config([]), facts({
    platform: 'linux',
    resolveExecutable: async () => '/usr/bin/editor',
    isDirectory: async () => true,
  }));
  assert.equal(onLinux.target, '/usr/bin/editor');
  assert.equal(onLinux.kind, 'argv');
});

test('an app with no chain on this platform resolves as absent', async () => {
  const entry = {
    id: 'winonly',
    label: 'winonly',
    locators: [],
    platforms: { win32: [{ kind: 'cli', command: 'thing', args: [] }] },
  };
  assert.equal(await resolveApp(entry, config([]), facts()), null);
});

test('an unresolvable app is absent while the rest of the menu resolves', async () => {
  const pass = await resolveCatalog(config([
    app('present', { kind: 'app', paths: ['/Applications/Present.app'], args: [] }),
    app('absent', { kind: 'app', paths: ['/Applications/Absent.app'], args: [] }),
  ]), facts({ isDirectory: async (path) => path === '/Applications/Present.app' }));
  assert.deepEqual([...pass.launches.keys()], ['present'], 'only installed apps are offered');
  assert.equal(pass.truncated, false);
});

test('a throwing seam resolves that entry as absent instead of failing the menu', async () => {
  const pass = await resolveCatalog(config([
    app('boom', { kind: 'app', paths: ['/Applications/Boom.app'], args: [] }),
    app('fine', { kind: 'app', paths: ['/Applications/Fine.app'], args: [] }),
  ]), facts({
    isDirectory: async (path) => {
      if (path.includes('Boom')) throw new Error('EACCES');
      return true;
    },
  }));
  assert.deepEqual([...pass.launches.keys()], ['fine']);
});

test('declared order is menu order', async () => {
  const pass = await resolveCatalog(config([
    app('third', { kind: 'app', paths: ['/Applications/C.app'], args: [] }),
    app('first', { kind: 'app', paths: ['/Applications/A.app'], args: [] }),
  ]), facts({ isDirectory: async () => true }));
  assert.deepEqual([...pass.launches.keys()], ['third', 'first'], 'the map preserves declaration order');
});

test('~/ and ${VAR} expand; an unset variable disqualifies the candidate', async () => {
  const f = facts({ env: { HOME: '/Users/tester', APPDIR: '/opt' } });
  assert.equal(expandPath('~/Applications/X.app', f), '/Users/tester/Applications/X.app');
  assert.equal(expandPath('${APPDIR}/X.app', f), '/opt/X.app');
  assert.equal(expandPath('/Applications/${MISSING}/X.app', f), null, 'an unset variable is not a path');
});

test('a candidate with an unset variable is skipped, not matched literally', async () => {
  const resolved = await resolveApp(
    app('x', { kind: 'app', paths: ['${MISSING}/X.app', '/Applications/X.app'], args: [] }),
    config([]),
    facts({ isDirectory: async () => true }),
  );
  assert.equal(resolved.target, '/Applications/X.app');
});

test('launchArgv appends the directory when no {path} token is declared', () => {
  assert.deepEqual(launchArgs([], '/work'), ['/work']);
  assert.deepEqual(launchArgs(['--new-window'], '/work'), ['--new-window', '/work']);
});

test('launchArgv substitutes a declared {path} token instead of appending', () => {
  assert.deepEqual(launchArgs([`--cd=${PATH_TOKEN}`], '/work'), ['--cd=/work']);
  assert.deepEqual(launchArgs(['--directory', PATH_TOKEN], '/work'), ['--directory', '/work']);
});

test('open kind launches by identity on macOS with the directory as its argument', async () => {
  const calls = [];
  const outcome = await launchResolved(
    { appId: 'zap', kind: 'open', target: '/Applications/Zap.app', args: [], iconPath: null, iconBundle: null },
    '/work',
    20,
    facts({ launch: async (command, args) => calls.push([command, args]) }),
  );
  assert.equal(outcome, 'launched');
  assert.deepEqual(calls, [['open', ['-a', '/Applications/Zap.app', '/work']]]);
});

test('open kind uses xdg-open on Linux', async () => {
  const calls = [];
  await launchResolved(
    { appId: 'x', kind: 'open', target: '/opt/x', args: [], iconPath: null, iconBundle: null },
    '/work',
    20,
    facts({ platform: 'linux', launch: async (command, args) => calls.push([command, args]) }),
  );
  assert.deepEqual(calls, [['xdg-open', ['/work']]]);
});

test('argv kind runs the resolved executable with the directory', async () => {
  const calls = [];
  await launchResolved(
    { appId: 'idea', kind: 'argv', target: '/usr/local/bin/idea', args: [], iconPath: null, iconBundle: null },
    '/work',
    20,
    facts({ launch: async (command, args) => calls.push([command, args]) }),
  );
  assert.deepEqual(calls, [['/usr/local/bin/idea', ['/work']]]);
});

test('a rejected launch reports failure rather than throwing', async () => {
  const outcome = await launchResolved(
    { appId: 'x', kind: 'argv', target: '/missing', args: [], iconPath: null, iconBundle: null },
    '/work',
    20,
    facts({ launch: async () => { throw new Error('ENOENT'); } }),
  );
  assert.equal(outcome, 'failed');
});

test('a pass that cannot finish inside its budget reports truncation', async () => {
  let clock = 0;
  const pass = await resolveCatalog(
    config([app('slow', { kind: 'app', paths: ['/Applications/Slow.app'], args: [] })], { resolveBudgetMs: 1 }),
    facts({
      now: () => (clock += 100),
      // Never settles: the budget, not the probe, must end the pass.
      isDirectory: () => new Promise(() => {}),
    }),
  );
  assert.equal(pass.truncated, true, 'an unfinished entry is reported, not silently dropped');
  assert.equal(pass.launches.size, 0);
});
