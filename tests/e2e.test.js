/**
 * End-to-end: a real HTTP request through the real route handler launches a
 * real detached process on a real directory.
 *
 * This is the check that a unit test cannot stand in for — it exercises the
 * fence, the body validation, the directory check, argv construction, the
 * detached spawn, and the response, in one pass. It uses `/usr/bin/open`
 * against a temporary directory that holds a file named after a URL scheme,
 * so the launch is observable without opening anything on screen.
 *
 * Skipped off macOS, where the `open` form uses a different launcher.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { Config, apply } from '../lib/index.js';

/**
 * Mount the plugin on a real server and return its base URL.
 *
 * The harness is hermetic: `storeDir` is pointed at a throwaway directory, so
 * the run never reads the operator's own
 * `~/.dsh/open-workspace-any-app/apps.json`. Without that, adding an app in the
 * real UI — or removing one — changes what these assertions see, and a test
 * that passes on one machine fails on the next for a reason that has nothing to
 * do with the code.
 * @param {object} pluginConfig - resolved plugin configuration.
 * @returns {Promise<{url: string, close: Function}>} the running harness.
 */
async function mountServer(pluginConfig) {
  const routes = new Map();
  const storeDir = await mkdtemp(join(tmpdir(), 'dsh-open-any-app-e2e-store-'));
  const ctx = {
    effect: (factory) => factory(),
    webServer: {
      register: (route) => {
        routes.set(`${route.kind}:${route.path}`, route.handler);
        return () => {};
      },
    },
    // The fence is stubbed to admit, so this test exercises the route logic
    // rather than the composition's authentication.
    connection: { requestRejection: () => undefined },
    subprocess: { resolveExecutable: async () => null },
  };
  apply(ctx, { ...pluginConfig, storeDir });

  const server = createServer((req, res) => {
    const pathname = new URL(req.url, 'http://x').pathname;
    const exact = routes.get(`exact:${pathname}`);
    if (exact !== undefined) {
      exact(req, res);
      return;
    }
    for (const [key, handler] of routes) {
      if (!key.startsWith('prefix:')) continue;
      const prefix = key.slice('prefix:'.length);
      if (pathname === prefix || pathname.startsWith(`${prefix}/`)) {
        handler(req, res);
        return;
      }
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    url: `http://127.0.0.1:${String(server.address().port)}`,
    close: async () => {
      await new Promise((resolve) => {
        server.close(resolve);
      });
      await rm(storeDir, { recursive: true, force: true });
    },
  };
}

test('a real POST launches a real process on a real directory', async (t) => {
  if (process.platform !== 'darwin') {
    t.skip('the open form uses a platform-specific launcher');
    return;
  }

  // `/usr/bin/true` proves the spawn path end to end: it resolves as a file,
  // runs by argv, and exits 0 inside the watch window, so a 200 means the
  // child genuinely started and finished cleanly.
  const pluginConfig = Config({
    apps: [{
      id: 'probe',
      label: 'Probe',
      locators: [{ kind: 'file', paths: ['/usr/bin/true'], args: [] }],
      launch: 'argv',
    }],
    launchWatchMs: 2_000,
  });

  const workDir = await mkdtemp(join(tmpdir(), 'dsh-open-any-app-e2e-'));
  const harness = await mountServer(pluginConfig);
  try {
    const response = await fetch(`${harness.url}/plugins/dsh-open-workspace-any-app/open`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ app: 'probe', path: workDir }),
    });
    assert.equal(response.status, 200, 'the launch succeeded');
    assert.deepEqual(await response.json(), { ok: true });
  } finally {
    await harness.close();
    await rm(workDir, { recursive: true, force: true });
  }
});

test('a real POST against a directory that does not exist is refused', async () => {
  const pluginConfig = Config({
    apps: [{
      id: 'probe',
      label: 'Probe',
      locators: [{ kind: 'file', paths: ['/usr/bin/true'], args: [] }],
      launch: 'argv',
    }],
  });
  const harness = await mountServer(pluginConfig);
  try {
    const response = await fetch(`${harness.url}/plugins/dsh-open-workspace-any-app/open`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ app: 'probe', path: '/definitely/not/a/directory/12345' }),
    });
    assert.equal(response.status, 404);
  } finally {
    await harness.close();
  }
});

test('a launch whose executable fails inside the watch window answers 502', async () => {
  const pluginConfig = Config({
    apps: [{
      id: 'failing',
      label: 'Failing',
      // `false` exits 1 immediately: inside the watch window that is a failure.
      locators: [{ kind: 'file', paths: ['/usr/bin/false'], args: [] }],
      launch: 'argv',
    }],
    launchWatchMs: 2_000,
  });
  const workDir = await mkdtemp(join(tmpdir(), 'dsh-open-any-app-e2e-fail-'));
  const harness = await mountServer(pluginConfig);
  try {
    const response = await fetch(`${harness.url}/plugins/dsh-open-workspace-any-app/open`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ app: 'failing', path: workDir }),
    });
    assert.equal(response.status, 502, 'an early nonzero exit is a failed launch');
  } finally {
    await harness.close();
    await rm(workDir, { recursive: true, force: true });
  }
});

test('the apps route serves the resolved catalog over real HTTP', async () => {
  const pluginConfig = Config({
    apps: [{
      id: 'probe',
      label: 'Probe Label',
      locators: [{ kind: 'file', paths: ['/usr/bin/true'], args: [] }],
      launch: 'argv',
    }],
  });
  const harness = await mountServer(pluginConfig);
  try {
    const response = await fetch(`${harness.url}/plugins/dsh-open-workspace-any-app/apps`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.apps, [{
      id: 'probe',
      label: 'Probe Label',
      source: 'declared',
      // /usr/bin/true is an executable, not a bundle: there is no icon source.
      icon: false,
    }]);
  } finally {
    await harness.close();
  }
});
