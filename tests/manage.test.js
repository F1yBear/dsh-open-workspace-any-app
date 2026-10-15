/**
 * The add / remove / discover routes, exercised over real HTTP against an
 * isolated store directory and a real application bundle.
 *
 * The bundle is a throwaway `.app` directory created under a temporary
 * directory, so these tests neither read nor write the operator's installed
 * applications or their real `~/.dsh` store.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { Config, apply } from '../lib/index.js';
import { readStore } from '../lib/store.js';
import { ADD_PATH, APPS_PATH, DISCOVER_PATH, REMOVE_PATH, RESTORE_PATH } from '../lib/shared.js';

/**
 * Create a throwaway `.app` bundle at `path`.
 * @param {string} path - bundle directory to create.
 * @returns {Promise<void>} resolves once the bundle exists.
 */
async function makeBundle(path) {
  await mkdir(join(path, 'Contents'), { recursive: true });
  await writeFile(join(path, 'Contents', 'Info.plist'), '<?xml version="1.0"?><plist version="1.0"><dict/></plist>\n', 'utf8');
}

/**
 * Mount the plugin over a real HTTP server with an isolated store.
 * @param {string} storeDir - directory for the UI-added store.
 * @param {object} [pluginConfig] - extra config overrides.
 * @returns {Promise<{url: string, close: Function}>} the running harness.
 */
async function mountServer(storeDir, pluginConfig = {}) {
  const routes = new Map();
  const ctx = {
    effect: (factory) => factory(),
    webServer: {
      register: (route) => {
        routes.set(`${route.kind}:${route.path}`, route.handler);
        return () => {};
      },
    },
    connection: { requestRejection: () => undefined },
    subprocess: {
      // PATH resolution is not what these tests exercise; a miss is a
      // legitimate answer for a locator that does not ask for it.
      resolveExecutable: async () => null,
    },
  };
  apply(ctx, Config({ apps: [], storeDir, ...pluginConfig }));

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
    close: () => new Promise((resolve) => {
      server.close(resolve);
    }),
  };
}

/**
 * POST one JSON body to a route.
 * @param {string} url - full URL.
 * @param {object} body - JSON body.
 * @returns {Promise<Response>} the response.
 */
function post(url, body) {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('adding a real bundle stores it and offers it in the menu', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-open-any-app-add-'));
  const storeDir = join(root, 'store');
  const bundle = join(root, 'Fake Editor.app');
  try {
    await makeBundle(bundle);
    const harness = await mountServer(storeDir);
    try {
      const before = await (await fetch(`${harness.url}${APPS_PATH}`)).json();
      assert.deepEqual(before.apps, [], 'nothing is offered before the addition');

      const added = await post(`${harness.url}${ADD_PATH}`, { label: 'Fake Editor', path: bundle });
      assert.equal(added.status, 200);
      const body = await added.json();
      assert.equal(body.ok, true);
      assert.equal(body.app.id, 'fake-editor', 'the id comes from the label');
      assert.equal(body.app.source, 'added');

      const after = await (await fetch(`${harness.url}${APPS_PATH}`)).json();
      assert.equal(after.apps.length, 1);
      assert.equal(after.apps[0].id, 'fake-editor');
      assert.equal(after.apps[0].label, 'Fake Editor');
      assert.equal(after.apps[0].source, 'added');
    } finally {
      await harness.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('an addition survives a fresh apply, because it is on disk', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-open-any-app-persist-'));
  const storeDir = join(root, 'store');
  const bundle = join(root, 'Persisted.app');
  try {
    await makeBundle(bundle);
    const first = await mountServer(storeDir);
    try {
      assert.equal((await post(`${first.url}${ADD_PATH}`, { label: 'Persisted', path: bundle })).status, 200);
    } finally {
      await first.close();
    }

    // A second mount stands in for a restarted host: the store file, not
    // process memory, is what carries the addition across.
    const second = await mountServer(storeDir);
    try {
      const apps = (await (await fetch(`${second.url}${APPS_PATH}`)).json()).apps;
      assert.deepEqual(apps.map((app) => app.id), ['persisted']);
    } finally {
      await second.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the added app is removable, and removal takes it out of the menu', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-open-any-app-remove-'));
  const storeDir = join(root, 'store');
  const bundle = join(root, 'Removable.app');
  try {
    await makeBundle(bundle);
    const harness = await mountServer(storeDir);
    try {
      await post(`${harness.url}${ADD_PATH}`, { label: 'Removable', path: bundle });
      assert.equal((await (await fetch(`${harness.url}${APPS_PATH}`)).json()).apps.length, 1);

      const removed = await post(`${harness.url}${REMOVE_PATH}`, { app: 'removable' });
      assert.equal(removed.status, 200);
      assert.deepEqual(await (await fetch(`${harness.url}${APPS_PATH}`)).json(), { apps: [] });
      assert.deepEqual((await readStore(join(storeDir, 'apps.json'))).apps, []);
    } finally {
      await harness.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a declared app IS removable: the reported defect', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-open-any-app-declared-'));
  const storeDir = join(root, 'store');
  const bundle = join(root, 'Declared.app');
  try {
    await makeBundle(bundle);
    // The declared entry points at the bundle this test created, so it
    // resolves and the removal is a real one.
    const harness = await mountServer(storeDir, {
      apps: [{ id: 'declared', label: 'Declared', locators: [{ kind: 'app', paths: [bundle], args: [] }] }],
    });
    try {
      const before = (await (await fetch(`${harness.url}${APPS_PATH}`)).json()).apps;
      assert.deepEqual(before.map((app) => app.id), ['declared'], 'the declared app is offered');

      const removed = await post(`${harness.url}${REMOVE_PATH}`, { app: 'declared' });
      assert.equal(removed.status, 200, 'a config-declared app must be removable');

      const after = await (await fetch(`${harness.url}${APPS_PATH}`)).json();
      assert.deepEqual(after.apps, [], 'it is gone from the menu');
      // And it is offered back rather than merely deleted.
      assert.deepEqual(after.hidden, [{ id: 'declared', label: 'Declared' }]);
    } finally {
      await harness.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a removed app can be restored, and the config file was never touched', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-open-any-app-restore-'));
  const storeDir = join(root, 'store');
  const bundle = join(root, 'Restorable.app');
  try {
    await makeBundle(bundle);
    const declared = [{ id: 'restorable', label: 'Restorable', locators: [{ kind: 'app', paths: [bundle], args: [] }] }];
    const harness = await mountServer(storeDir, { apps: declared });
    try {
      await post(`${harness.url}${REMOVE_PATH}`, { app: 'restorable' });
      assert.deepEqual((await (await fetch(`${harness.url}${APPS_PATH}`)).json()).apps, []);

      const restored = await post(`${harness.url}${RESTORE_PATH}`, { app: 'restorable' });
      assert.equal(restored.status, 200);
      const apps = (await (await fetch(`${harness.url}${APPS_PATH}`)).json()).apps;
      assert.deepEqual(apps.map((app) => app.id), ['restorable'], 'it comes back');

      // The removal lived in the store, so the caller's own config object is
      // untouched — a plugin must never rewrite the operator's document.
      assert.deepEqual(declared.map((app) => app.id), ['restorable']);
    } finally {
      await harness.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('removing an id nothing offers is refused', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-open-any-app-unknown-'));
  try {
    const harness = await mountServer(join(root, 'store'));
    try {
      assert.equal((await post(`${harness.url}${REMOVE_PATH}`, { app: 'ghost' })).status, 404);
    } finally {
      await harness.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('restoring an id that is not removed is refused', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-open-any-app-notremoved-'));
  try {
    const harness = await mountServer(join(root, 'store'));
    try {
      assert.equal((await post(`${harness.url}${RESTORE_PATH}`, { app: 'ghost' })).status, 404);
    } finally {
      await harness.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('adding a bundle that does not exist is refused', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-open-any-app-missing-'));
  try {
    const harness = await mountServer(join(root, 'store'));
    try {
      const response = await post(`${harness.url}${ADD_PATH}`, {
        label: 'Ghost',
        path: join(root, 'Ghost.app'),
      });
      assert.equal(response.status, 404, 'a typo must not become a menu entry that never appears');
    } finally {
      await harness.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('adding a relative path is refused', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-open-any-app-relative-'));
  try {
    const harness = await mountServer(join(root, 'store'));
    try {
      const response = await post(`${harness.url}${ADD_PATH}`, { label: 'Rel', path: 'Applications/Rel.app' });
      assert.equal(response.status, 400);
    } finally {
      await harness.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the mutation routes validate their bodies like the launch route', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-open-any-app-body-'));
  try {
    const harness = await mountServer(join(root, 'store'));
    try {
      // Wrong media type.
      assert.equal((await fetch(`${harness.url}${ADD_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: '{}',
      })).status, 415);
      // Malformed JSON.
      assert.equal((await fetch(`${harness.url}${ADD_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: 'not json',
      })).status, 400);
      // Missing the required field. `label` is optional: the system chooser
      // returns a path and nothing else, so requiring a name would be the
      // developer-shaped step this flow removes.
      assert.equal((await post(`${harness.url}${ADD_PATH}`, { label: 'x' })).status, 400);
      // Blank required field.
      assert.equal((await post(`${harness.url}${ADD_PATH}`, { label: 'x', path: '' })).status, 400);
      // A label alone is not enough: the path is what identifies the app.
      assert.equal((await post(`${harness.url}${ADD_PATH}`, { path: '/definitely/not/here.app' })).status, 404);
      // Wrong method.
      assert.equal((await fetch(`${harness.url}${ADD_PATH}`)).status, 405);
    } finally {
      await harness.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('adding twice under one label yields two distinct ids', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-open-any-app-dup-'));
  const storeDir = join(root, 'store');
  try {
    const one = join(root, 'Editor One.app');
    const two = join(root, 'Editor Two.app');
    await makeBundle(one);
    await makeBundle(two);
    const harness = await mountServer(storeDir);
    try {
      const first = await (await post(`${harness.url}${ADD_PATH}`, { label: 'Editor', path: one })).json();
      const second = await (await post(`${harness.url}${ADD_PATH}`, { label: 'Editor', path: two })).json();
      assert.equal(first.app.id, 'editor');
      assert.equal(second.app.id, 'editor-2', 'a shared label must not collide');
      const apps = (await (await fetch(`${harness.url}${APPS_PATH}`)).json()).apps;
      assert.deepEqual(apps.map((app) => app.id), ['editor', 'editor-2']);
    } finally {
      await harness.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the discover route offers installed bundles and not what is already in the menu', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-open-any-app-discover-'));
  try {
    // discoverApps scans fixed macOS roots, so this asserts the exclusion
    // contract against whatever this machine has rather than a synthetic root.
    const harness = await mountServer(join(root, 'store'));
    try {
      const first = await (await fetch(`${harness.url}${DISCOVER_PATH}`)).json();
      assert.ok(Array.isArray(first.candidates));
      for (const candidate of first.candidates) {
        assert.equal(typeof candidate.path, 'string');
        assert.equal(typeof candidate.label, 'string');
        assert.match(candidate.path, /^\//, 'every candidate is an absolute path');
      }
      const paths = first.candidates.map((candidate) => candidate.path);
      assert.equal(new Set(paths).size, paths.length, 'no duplicate candidates');

      // Adding one candidate must remove it from the next scan.
      if (paths.length > 0) {
        const [chosen] = first.candidates;
        assert.equal((await post(`${harness.url}${ADD_PATH}`, { label: chosen.label, path: chosen.path })).status, 200);
        const second = await (await fetch(`${harness.url}${DISCOVER_PATH}`)).json();
        assert.ok(
          !second.candidates.some((candidate) => candidate.path === chosen.path),
          'an offered app is not offered again',
        );
      }
    } finally {
      await harness.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the mutation routes honor the trust fence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-open-any-app-fence-'));
  try {
    const routes = new Map();
    const ctx = {
      effect: (factory) => factory(),
      webServer: {
        register: (route) => {
          routes.set(`${route.kind}:${route.path}`, route.handler);
          return () => {};
        },
      },
      connection: { requestRejection: () => 403 },
      subprocess: { resolveExecutable: async () => null },
    };
    apply(ctx, Config({ apps: [], storeDir: join(root, 'store') }));
    const server = createServer((req, res) => {
      const pathname = new URL(req.url, 'http://x').pathname;
      const handler = routes.get(`exact:${pathname}`);
      if (handler !== undefined) {
        handler(req, res);
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    const url = `http://127.0.0.1:${String(server.address().port)}`;
    try {
      for (const path of [ADD_PATH, REMOVE_PATH, DISCOVER_PATH, APPS_PATH]) {
        const response = path === DISCOVER_PATH || path === APPS_PATH
          ? await fetch(`${url}${path}`)
          : await post(`${url}${path}`, { label: 'x', path: '/x', app: 'x' });
        assert.equal(response.status, 403, `${path} must be fenced`);
      }
    } finally {
      await new Promise((resolve) => {
        server.close(resolve);
      });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
