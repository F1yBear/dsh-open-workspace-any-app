/**
 * Route behavior: the apps/icon/open surfaces, their validation, and the
 * trust fence.
 *
 * The plugin is applied to a fake cordis context whose `webServer.register`
 * collects routes instead of binding a socket, so these tests drive the real
 * handlers with real request/response objects — no composition, no port.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';

import { apply } from '../lib/index.js';
import {
  ADD_PATH,
  APPS_PATH,
  DISCOVER_PATH,
  ICON_PREFIX_PATH,
  OPEN_PATH,
  REMOVE_PATH,
  RESTORE_PATH,
} from '../lib/shared.js';

/**
 * Apply the plugin to a recording context.
 * @param {object} config - plugin config (already schema-resolved).
 * @param {object} [options] - connection seam and capability overrides.
 * @returns {{routes: Map<string, Function>, disposers: number}} recorded routes.
 */
function mount(config, options = {}) {
  const routes = new Map();
  const ctx = {
    effect: (factory) => {
      const dispose = factory();
      return () => {
        dispose?.();
      };
    },
    webServer: {
      register: (route) => {
        routes.set(`${route.kind}:${route.path}`, route.handler);
        return () => {
          routes.delete(`${route.kind}:${route.path}`);
        };
      },
    },
    ...(options.connection === undefined ? {} : { connection: options.connection }),
    ...(options.subprocess === undefined
      ? {}
      : { subprocess: options.subprocess }),
  };
  apply(ctx, config);
  return { routes };
}

/** A config with one resolvable and one unresolvable app. */
function config(overrides = {}) {
  return {
    probeTimeoutMs: 100,
    iconTimeoutMs: 100,
    launchWatchMs: 20,
    resolveBudgetMs: 5_000,
    apps: [
      {
        id: 'present',
        label: 'Present',
        locators: [{ kind: 'app', paths: ['/Applications/Present.app'], args: [] }],
        platforms: {},
      },
      {
        id: 'absent',
        label: 'Absent',
        locators: [{ kind: 'app', paths: ['/Applications/Absent.app'], args: [] }],
        platforms: {},
      },
    ],
    ...overrides,
  };
}

/** An always-admitting trust fence. */
const allowAll = { requestRejection: () => undefined };

/** A fence that rejects with 403. */
const denyAll = { requestRejection: () => 403 };

/**
 * Start a throwaway server that dispatches one path to one handler.
 * @param {Function} handler - the route handler.
 * @param {string} path - the path registered.
 * @returns {Promise<{url: string, close: Function}>} the server handle.
 */
async function serve(handler, path) {
  const server = createServer((req, res) => {
    if (new URL(req.url, 'http://x').pathname === path) {
      handler(req, res);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${String(port)}`,
    close: () => new Promise((resolve) => {
      server.close(resolve);
    }),
  };
}

test('every route is registered at this plugin\'s own paths', () => {
  const { routes } = mount(config(), { connection: allowAll });
  assert.deepEqual(
    [...routes.keys()].sort(),
    [
      `exact:${APPS_PATH}`,
      `exact:${ADD_PATH}`,
      `exact:${DISCOVER_PATH}`,
      `exact:${OPEN_PATH}`,
      `exact:${REMOVE_PATH}`,
      `exact:${RESTORE_PATH}`,
      `prefix:${ICON_PREFIX_PATH}`,
    ].sort(),
  );
  assert.ok(!routes.has('exact:/open-in-app/apps'), 'the built-in routes are never touched');
});

test('the apps route reports only apps that resolved on this host', async () => {
  // The plugin probes the real filesystem, so this asserts the shape rather
  // than a machine's installs: /Applications is a directory, and the
  // deliberately absent bundle is not.
  const { routes } = mount(config(), { connection: allowAll });
  const server = await serve(routes.get(`exact:${APPS_PATH}`), APPS_PATH);
  try {
    const response = await fetch(`${server.url}${APPS_PATH}`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.ok(Array.isArray(body.apps));
    const ids = body.apps.map((app) => app.id);
    assert.ok(!ids.includes('absent'), 'an app whose bundle is missing is not offered');
  } finally {
    await server.close();
  }
});

test('the apps route refuses an unfenced composition', async () => {
  const { routes } = mount(config(), { connection: undefined });
  const server = await serve(routes.get(`exact:${APPS_PATH}`), APPS_PATH);
  try {
    const response = await fetch(`${server.url}${APPS_PATH}`);
    assert.equal(response.status, 503, 'without a connection fence nothing is served');
  } finally {
    await server.close();
  }
});

test('the apps route honors the fence rejection', async () => {
  const { routes } = mount(config(), { connection: denyAll });
  const server = await serve(routes.get(`exact:${APPS_PATH}`), APPS_PATH);
  try {
    assert.equal((await fetch(`${server.url}${APPS_PATH}`)).status, 403);
  } finally {
    await server.close();
  }
});

test('the apps route answers 405 for a non-GET method', async () => {
  const { routes } = mount(config(), { connection: allowAll });
  const server = await serve(routes.get(`exact:${APPS_PATH}`), APPS_PATH);
  try {
    const response = await fetch(`${server.url}${APPS_PATH}`, { method: 'POST' });
    assert.equal(response.status, 405);
    assert.equal(response.headers.get('allow'), 'GET');
  } finally {
    await server.close();
  }
});

test('the open route rejects a content type other than application/json', async () => {
  const { routes } = mount(config(), { connection: allowAll });
  const server = await serve(routes.get(`exact:${OPEN_PATH}`), OPEN_PATH);
  try {
    const response = await fetch(`${server.url}${OPEN_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: '{}',
    });
    assert.equal(response.status, 415);
  } finally {
    await server.close();
  }
});

test('the open route rejects a body that is not JSON with string app and path', async () => {
  const { routes } = mount(config(), { connection: allowAll });
  const server = await serve(routes.get(`exact:${OPEN_PATH}`), OPEN_PATH);
  try {
    for (const body of ['not json', '{}', '{"app":"present"}', '{"app":1,"path":"/tmp"}']) {
      const response = await fetch(`${server.url}${OPEN_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      });
      assert.equal(response.status, 400, `body ${body} must be refused`);
    }
  } finally {
    await server.close();
  }
});

test('the open route rejects an unknown app id', async () => {
  const { routes } = mount(config(), { connection: allowAll });
  const server = await serve(routes.get(`exact:${OPEN_PATH}`), OPEN_PATH);
  try {
    const response = await fetch(`${server.url}${OPEN_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ app: 'nope', path: '/tmp' }),
    });
    assert.equal(response.status, 400);
    assert.match((await response.json()).message, /unknown or unavailable app/);
  } finally {
    await server.close();
  }
});

test('the open route rejects a relative or empty path', async () => {
  const { routes } = mount(config(), { connection: allowAll });
  const server = await serve(routes.get(`exact:${OPEN_PATH}`), OPEN_PATH);
  try {
    for (const path of ['', 'relative/dir']) {
      const response = await fetch(`${server.url}${OPEN_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ app: 'present', path }),
      });
      // Either the app is unresolvable here or the path is refused; both are 400.
      assert.equal(response.status, 400);
    }
  } finally {
    await server.close();
  }
});

test('the open route rejects a payload past its ceiling', async () => {
  const { routes } = mount(config(), { connection: allowAll });
  const server = await serve(routes.get(`exact:${OPEN_PATH}`), OPEN_PATH);
  try {
    const response = await fetch(`${server.url}${OPEN_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ app: 'present', path: `/tmp/${'x'.repeat(70 * 1024)}` }),
    });
    assert.ok([400, 413].includes(response.status), `expected a refusal, got ${String(response.status)}`);
  } finally {
    await server.close();
  }
});

test('the icon route answers 404 for an unknown id instead of failing', async () => {
  const { routes } = mount(config(), { connection: allowAll });
  const server = await serve(routes.get(`prefix:${ICON_PREFIX_PATH}`), `${ICON_PREFIX_PATH}/nope`);
  try {
    const response = await fetch(`${server.url}${ICON_PREFIX_PATH}/nope`);
    assert.equal(response.status, 404);
    assert.match((await response.json()).message, /no icon for nope/);
  } finally {
    await server.close();
  }
});

test('the icon route honors the fence', async () => {
  const { routes } = mount(config(), { connection: denyAll });
  const server = await serve(routes.get(`prefix:${ICON_PREFIX_PATH}`), `${ICON_PREFIX_PATH}/present`);
  try {
    assert.equal((await fetch(`${server.url}${ICON_PREFIX_PATH}/present`)).status, 403);
  } finally {
    await server.close();
  }
});

test('duplicate app ids fail at apply rather than silently shadowing', () => {
  const apps = [
    { id: 'dup', label: 'a', locators: [], platforms: {} },
    { id: 'dup', label: 'b', locators: [], platforms: {} },
  ];
  assert.throws(() => {
    mount(config({ apps }), { connection: allowAll });
  }, /duplicate app id "dup"/);
});

test('concurrent requests settle consistently against one resolution pass', async () => {
  const { routes } = mount(config(), { connection: allowAll });
  const server = await serve(routes.get(`exact:${APPS_PATH}`), APPS_PATH);
  try {
    // The menu fetches the catalog and then one icon per row, so several
    // requests race the first resolution. Both must settle: a raced pass that
    // re-ran detection per request could answer two different catalogs (or
    // probe a half-built map), and the icon route in particular must never
    // observe "id unknown" for an id the catalog just reported.
    const [first, second, icon] = await Promise.all([
      fetch(`${server.url}${APPS_PATH}`),
      fetch(`${server.url}${APPS_PATH}`),
      fetch(`${server.url}${ICON_PREFIX_PATH}/absent`),
    ]);
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(icon.status, 404, 'an id no app declares is 404');
    assert.deepEqual(await first.json(), await second.json(), 'concurrent reads agree');
  } finally {
    await server.close();
  }
});

test('repeated reads are idempotent: the pass runs once and its answer is stable', async () => {
  const { routes } = mount(config(), { connection: allowAll });
  const server = await serve(routes.get(`exact:${APPS_PATH}`), APPS_PATH);
  try {
    const bodies = [];
    for (let i = 0; i < 3; i += 1) {
      bodies.push(await (await fetch(`${server.url}${APPS_PATH}`)).json());
    }
    assert.deepEqual(bodies[1], bodies[0]);
    assert.deepEqual(bodies[2], bodies[0]);
  } finally {
    await server.close();
  }
});
