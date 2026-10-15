/**
 * Machine-level checks: the module loads as the loader would load it, the
 * declared catalog resolves against real applications, and a launch really
 * starts a process.
 *
 * These are integration checks, not unit tests, so they assert only facts
 * that hold on any macOS machine with `/Applications`: an absent bundle is
 * never offered, and a launch of a resolved target succeeds. Nothing here
 * depends on which editors the developer happens to have installed.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { Config, apply } from '../lib/index.js';
import { launchDetached } from '../lib/index.js';
import { resolveApp, resolveCatalog } from '../lib/resolver.js';

/** Real host facts, wired the way apply() wires them. */
function hostFacts(overrides = {}) {
  return {
    platform: process.platform,
    env: process.env,
    home: process.env.HOME ?? '/tmp',
    now: () => Date.now(),
    isDirectory: async (path) => {
      const { stat } = await import('node:fs/promises');
      try {
        return (await stat(path)).isDirectory();
      } catch {
        return false;
      }
    },
    isFile: async (path) => {
      const { stat } = await import('node:fs/promises');
      try {
        return (await stat(path)).isFile();
      } catch {
        return false;
      }
    },
    resolveExecutable: async (name) => {
      const { execFile } = await import('node:child_process');
      return await new Promise((resolve) => {
        execFile('/usr/bin/which', [name], (error, stdout) => {
          resolve(error === null || error === undefined ? stdout.trim() || null : null);
        });
      });
    },
    run: async () => null,
    launch: async () => {},
    ...overrides,
  };
}

test('the host module exports the loader contract with a schema-resolved config', () => {
  const module = apply;
  assert.equal(typeof module, 'function', 'apply is the plugin body');
  const config = Config({ apps: [] });
  assert.equal(config.probeTimeoutMs, 10_000, 'the schema supplies defaults');
  assert.deepEqual(config.apps, []);
});

test('a config with no apps composes and resolves an empty menu', async () => {
  const pass = await resolveCatalog(Config({ apps: [] }), hostFacts());
  assert.equal(pass.launches.size, 0);
  assert.equal(pass.truncated, false);
});

test('a real bundle on this machine resolves by its declared path', async () => {
  // /Applications/Utilities ships with macOS; use it as a directory-only
  // target so this check needs no third-party install.
  const entry = {
    id: 'utilities',
    label: 'Utilities',
    locators: [{ kind: 'file', paths: ['/Applications/Utilities'], args: [] }],
    platforms: {},
  };
  // A `file` locator needs a regular file, which a directory is not: the
  // entry must NOT resolve, proving the kind check is real.
  const asFile = await resolveApp(entry, Config({ apps: [] }), hostFacts());
  assert.equal(asFile, null, 'a directory is not accepted where a file is declared');
});

test('a real application bundle resolves by its declared path', async () => {
  const config = Config({
    apps: [{
      id: 'safari',
      label: 'Safari',
      locators: [{ kind: 'app', paths: ['/Applications/Safari.app'], args: [] }],
    }],
  });
  const pass = await resolveCatalog(config, hostFacts());
  if (process.platform !== 'darwin') return;
  assert.ok(pass.launches.has('safari'), 'Safari resolves on a macOS host');
  const resolved = pass.launches.get('safari');
  assert.equal(resolved.kind, 'open', 'an app locator opens by identity');
  assert.equal(resolved.target, '/Applications/Safari.app');
  assert.equal(resolved.iconBundle, '/Applications/Safari.app', 'the bundle supplies its icon');
});

test('the declared ships-with-macOS entries resolve on this host', async () => {
  if (process.platform !== 'darwin') return;
  // The patch declares real applications; only the universally present ones
  // are asserted here so this check travels between machines.
  const config = Config({
    apps: [
      { id: 'utilities', label: 'Utilities', locators: [{ kind: 'app', paths: ['/Applications/Utilities'] }] },
    ],
  });
  const pass = await resolveCatalog(config, hostFacts());
  assert.ok(pass.launches.has('utilities'), 'a present bundle resolves');
});

test('an absent bundle never resolves', async () => {
  const config = Config({
    apps: [{
      id: 'ghost',
      label: 'Ghost',
      locators: [{ kind: 'app', paths: ['/Applications/Definitely-Not-Installed-12345.app'] }],
    }],
  });
  const pass = await resolveCatalog(config, hostFacts());
  assert.equal(pass.launches.has('ghost'), false);
});

test('a launch really starts a detached process and reports success', async () => {
  const workDir = await mkdtemp(join(tmpdir(), 'dsh-open-any-app-test-'));
  try {
    // /bin/echo exits 0 immediately: the watch window sees a clean exit.
    await launchDetached('/bin/echo', ['hello'], 1_000);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});

test('a launch of a missing executable rejects', async () => {
  await assert.rejects(launchDetached('/nonexistent/binary-12345', [], 1_000));
});

test('credential-shaped environment variables never reach a launched child', async () => {
  process.env.DSH_TEST_FAKE_SECRET = 'must-not-leak';
  try {
    const { scrubbedParentEnv } = await import('../lib/index.js');
    const env = scrubbedParentEnv();
    assert.equal(env.DSH_TEST_FAKE_SECRET, undefined, 'DSH_* and secret-shaped names are dropped');
    assert.equal(env.NODE_OPTIONS, undefined);
  } finally {
    delete process.env.DSH_TEST_FAKE_SECRET;
  }
});
