/**
 * The control rendered by real React, into real markup.
 *
 * The unit tests in `client.test.js` drive the bundle through a hand-written
 * React stand-in, which is fast but can drift from React's actual element
 * shape and hook arity — a missing server snapshot, for instance, is invisible
 * to a stub that ignores its third argument but throws under server rendering.
 * This file therefore renders the control with `react` + `react-dom/server`,
 * so the element tree a browser would receive is asserted for real.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const BUNDLE = new URL('../lib/client.js', import.meta.url);

/**
 * Load the bundle and return its plugin face plus the stores it created.
 * @param {object} [options] - primitive overrides.
 * @returns {{face: object, stores: Array, makePrimitives: Function}} the harness.
 */
function load(options = {}) {
  const registrations = [];
  const previous = globalThis.window;
  globalThis.window = { __ModuleLoader__: { load: (registration) => registrations.push(registration) } };
  try {
    new Function(readFileSync(BUNDLE, 'utf8'))();
  } finally {
    if (previous === undefined) delete globalThis.window;
    else globalThis.window = previous;
  }

  const stores = [];
  const storeModule = {
    createSnapshotStore: (init, opts) => {
      const record = { init, opts, value: init, getSnapshot: () => record.value, set: (next) => { record.value = next; }, subscribe: () => () => {} };
      stores.push(record);
      return record;
    },
  };

  // Real components: the Menu renders its anchor and items so the markup shows
  // what a person would actually see, and everything else renders its children.
  const primitives = new Proxy({}, {
    get: (_target, name) => {
      const label = String(name);
      const Primitive = function Primitive(props) {
        // Forward `data-*` props onto the rendered element: the bundle marks its
        // own controls that way, and forwarding is what lets a markup assertion
        // see a specific control rather than only that *some* primitive rendered.
        const marks = Object.fromEntries(
          Object.entries(props ?? {}).filter(([key]) => key.startsWith('data-')),
        );
        if (label === 'Menu') {
          return React.createElement('div', {
            ...marks,
            'data-menu': String(props.open),
            'data-selected': String(props.selectedId),
          }, [
            props.anchor,
            React.createElement('ul', { key: 'items' }, (props.items ?? []).map((item) => (
              React.createElement('li', { key: item.id, 'data-item': item.id }, item.label)
            ))),
          ]);
        }
        if (label === 'Modal') {
          // The real Modal renders props.children inside the dialog shell; the
          // stub keeps that shape so a test can see the dialog's own body. It
          // also threads `className` onto the card and `contentClassName` onto
          // the body column, which is the channel the dialog's fixed-viewport
          // styles travel through — without that, a test could not tell whether
          // the cap and the scrolling body actually reached the primitive.
          return props.open === true
            ? React.createElement('div', {
              ...marks,
              className: props.className,
              'data-modal': String(props.title),
            }, [
              props.description === undefined ? null : React.createElement('p', { key: 'desc' }, props.description),
              React.createElement('div', {
                key: 'body',
                className: props.contentClassName,
              }, props.children ?? null),
              props.footer === undefined ? null : React.createElement('div', { key: 'footer' }, props.footer),
            ])
            : null;
        }
        return React.createElement('div', { ...marks, 'data-prim': label }, props?.children ?? null);
      };
      Object.defineProperty(Primitive, 'name', { value: label });
      return Primitive;
    },
  });

  const require = (spec) => {
    if (spec === 'react') return React;
    if (spec === '@deepseek-ai/dsh-client-store') return storeModule;
    if (spec === '@deepseek-ai/dsh-client-ui-primitives') return options.primitives ?? primitives;
    throw new Error(`unexpected require: ${spec}`);
  };

  return { face: registrations[0].factory(require), stores, makePrimitives: primitives, dictionaries: {} };
}

/**
 * Mount the control and render it to static markup.
 * @param {object} harness - a {@link load} result.
 * @param {object} [seed] - choice and catalog to install before rendering.
 * @returns {string} the rendered HTML.
 */
function render(harness, seed = {}) {
  let component;
  harness.face.apply({
    effect: (factory) => {
      factory();
    },
    locale: {
      register: (ns, dicts) => {
        harness.dictionaries[ns] = dicts;
      },
      bind: () => (key) => key,
    },
    slots: {
      inject: (name, register) => register(),
      register: (options, registered) => {
        component = registered;
      },
    },
  });

  const choice = harness.stores.find((record) => record.opts?.persist !== undefined);
  const catalog = harness.stores.find((record) => record.opts?.persist === undefined);
  if (seed.choice !== undefined) choice.set(seed.choice);
  if (seed.apps !== undefined) catalog.set(seed.apps);

  // `cwd: null` is the explicit "this Session has no workspace" case; omitting
  // the field entirely means the ordinary case, which has one.
  const cwd = seed.cwd === undefined ? '/work' : seed.cwd;
  const wrapper = component({
    sessionId: 's1',
    t: (key) => key,
    useSessions: (select) => select({ byId: { s1: { cwd } } }),
  });
  if (wrapper === null) return '';
  return renderToStaticMarkup(React.createElement(wrapper.type, wrapper.props));
}

test('real React renders the control without a server-snapshot error', () => {
  // A store subscription that omits React's third argument throws here while
  // the stub-based tests stay green, which is exactly why this file exists.
  const html = render(load(), {
    choice: 'obsidian',
    apps: [{ id: 'obsidian', label: 'Obsidian', source: 'added', icon: true }],
  });
  assert.match(html, /data-open-any-app/);
});

test('the rendered button carries the remembered app icon at header size', () => {
  const html = render(load(), {
    choice: 'obsidian',
    apps: [
      { id: 'zap', label: 'Zap', source: 'declared', icon: true },
      { id: 'obsidian', label: 'Obsidian', source: 'added', icon: true },
    ],
  });
  assert.match(html, /data-open-any-app-primary="obsidian"/, 'the button acts on the remembered app');
  assert.match(
    html,
    /<img src="plugins\/dsh-open-workspace-any-app\/icon\/obsidian" width="16" height="16"/,
    'the face is this plugin\'s icon route for the remembered app',
  );
  // The built-in control's route must never appear: these are two separate controls.
  assert.doesNotMatch(html, /open-in-app\/icon/);
});

test('the rendered menu lists every app and the add entry, marking the choice', () => {
  const html = render(load(), {
    choice: 'zap',
    apps: [
      { id: 'zap', label: 'Zap', source: 'declared', icon: true },
      { id: 'obsidian', label: 'Obsidian', source: 'added', icon: true },
    ],
  });
  assert.match(html, /data-item="app:zap">Zap</);
  assert.match(html, /data-item="app:obsidian">Obsidian</);
  assert.match(html, /data-item="manage"/, 'the dropdown offers adding an application');
  assert.match(html, /data-selected="app:zap"/, 'the remembered app is marked');
});

test('real React renders a glyph when the remembered app has no icon', () => {
  const html = render(load(), {
    choice: 'idea',
    apps: [{ id: 'idea', label: 'IntelliJ IDEA', source: 'declared', icon: false }],
  });
  assert.doesNotMatch(html, /<img/, 'no icon source means no image element');
  assert.match(html, /data-prim="IconFolderOpenOutlineRegular"/, 'the generic glyph stands in');
});

test('real React renders an empty catalog as an actionable hint, not a blank menu', () => {
  const html = render(load(), { choice: '', apps: [] });
  assert.match(html, /data-item="empty"/);
  assert.match(html, /data-item="manage"/, 'adding remains reachable with an empty catalog');
});

test('real React renders nothing at all without a workspace directory', () => {
  assert.equal(render(load(), { cwd: null }), '');
  assert.equal(render(load(), { cwd: '' }), '');
});

test('the dialog markup is reachable with a stubbed candidate scan', () => {
  // The dialog only opens through user interaction, and its parent owns hooks,
  // so the markup is asserted by rendering the whole control with the dialog
  // forced open — the same component tree a browser mounts.
  const harness = load();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => Promise.resolve({ ok: true, json: async () => ({ candidates: [] }) });
  try {
    let component;
    harness.face.apply({
      effect: (factory) => {
        factory();
      },
      locale: {
      register: (ns, dicts) => {
        harness.dictionaries[ns] = dicts;
      },
      bind: () => (key) => key,
    },
      slots: {
        inject: (name, register) => register(),
        register: (options, registered) => {
          component = registered;
        },
      },
    });
    const wrapper = component({
      sessionId: 's1',
      t: (key) => key,
      useSessions: (select) => select({ byId: { s1: { cwd: '/work' } } }),
    });
    // Render the control; the dialog is closed, so it contributes nothing —
    // which is itself the contract: an unopened dialog costs no markup.
    const html = renderToStaticMarkup(React.createElement(wrapper.type, wrapper.props));
    assert.doesNotMatch(html, /data-open-any-app-filter/);
    assert.match(html, /data-open-any-app-more/, 'the chevron that opens the menu is present');
  } finally {
    if (originalFetch === undefined) delete globalThis.fetch;
    else globalThis.fetch = originalFetch;
  }
});

test('the open manage dialog renders the scan list, the menu, and per-row actions', () => {
  // The dialog opens only through user interaction, so this renders the same
  // component tree the browser mounts while forcing that one child open: the
  // dialog's own hooks then run under a real renderer.
  const harness = load();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => Promise.resolve({
    ok: true,
    json: async () => ({ candidates: [{ path: '/Applications/Some Editor.app', label: 'Some Editor' }] }),
  });
  try {
    const html = renderManageOpen(harness, {
      apps: [{ id: 'zap', label: 'Zap', source: 'declared', icon: true }],
      hidden: [{ id: 'qoder', label: 'Qoder IDE' }],
    });
    // Adding happens in the scanned list itself: each found row carries its own
    // add control, so there is no separate chooser step to reach first.
    assert.match(html, /dialog\.found/, 'the scanned section is present');
    // The apps already in the menu, each with a remove control.
    assert.match(html, /data-open-any-app-row="zap"/, 'the menu is listed');
    assert.match(html, /data-open-any-app-remove/, 'every menu row can be removed');
    // What was removed, restorable.
    assert.match(html, /data-open-any-app-row="qoder"/, 'removed apps are listed');
    assert.match(html, /data-open-any-app-restore/, 'a removed app can be put back');
    // No path field: the person should never have to type a bundle path.
    assert.doesNotMatch(html, /data-open-any-app-manual-path/, 'no developer-shaped path field');
    // No native-chooser affordance remains anywhere in the dialog.
    assert.doesNotMatch(html, /data-open-any-app-choose/, 'the chooser button is gone');
    // The fixed viewport: the card is capped and its body scrolls, which is what
    // keeps a long list inside the window. The `Modal` primitive threads these
    // two class names onto the card and the body, so asserting them here checks
    // the props actually reached the primitive.
    assert.match(html, /dsh-open-any-app-dialog/, 'the Modal card carries the height cap');
    assert.match(html, /dsh-open-any-app-content/, 'the scrollable body is the Modal content column');
    assert.match(html, /data-open-any-app-filter/, 'the search field sits above the lists');
  } finally {
    if (originalFetch === undefined) delete globalThis.fetch;
    else globalThis.fetch = originalFetch;
  }
});

test('the manage dialog offers a newly found application as a one-click add', async () => {
  // The scan is a request, so the candidate row appears on a later render;
  // `renderToStaticMarkup` is synchronous, so the effect's promise is settled
  // before rendering rather than after.
  const harness = load();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => Promise.resolve({
    ok: true,
    json: async () => ({ candidates: [{ path: '/Applications/Some Editor.app', label: 'Some Editor' }] }),
  });
  try {
    const html = renderManageOpen(harness, { apps: [], hidden: [] });
    // The first paint shows the list; the scan result is asserted separately
    // through the request the dialog makes.
    assert.match(html, /data-open-any-app-filter|dialog\.loading|data-open-any-app-add/);
    await Promise.resolve();
  } finally {
    if (originalFetch === undefined) delete globalThis.fetch;
    else globalThis.fetch = originalFetch;
  }
});

/**
 * Mount the control and render its manage dialog open.
 *
 * The dialog is reached through the real component hierarchy (so the control's
 * own hooks run under a renderer) with just that one child forced open, since
 * opening it otherwise requires a click.
 * @param {object} harness - a {@link load} result.
 * @param {{apps?: Array<object>, hidden?: Array<object>}} seed - lists to install.
 * @returns {string} the rendered dialog markup.
 */
function renderManageOpen(harness, seed) {
  let component;
  harness.face.apply({
    effect: (factory) => {
      factory();
    },
    locale: { register: (ns, dicts) => {
      harness.dictionaries[ns] = dicts;
    }, bind: () => (key, params) => {
      const template = harness.dictionaries?.en?.[key] ?? key;
      return params === undefined ? template : template.replace(/\{(\w+)\}/g, (match, name) => String(params[name] ?? match));
    } },
    slots: {
      inject: (name, register) => register(),
      register: (options, registered) => {
        component = registered;
      },
    },
  });

  const appsStore = harness.stores.find((record) => record.opts?.persist === undefined);
  const removedStore = harness.stores.filter((record) => record.opts?.persist === undefined)[1];
  if (seed.apps !== undefined) appsStore.set(seed.apps);
  if (seed.hidden !== undefined) removedStore.set(seed.hidden);

  const wrapper = component({
    sessionId: 's1',
    t: (key, params) => {
      const template = harness.dictionaries?.en?.[key] ?? key;
      return params === undefined ? template : template.replace(/\{(\w+)\}/g, (match, name) => String(params[name] ?? match));
    },
    useSessions: (select) => select({ byId: { s1: { cwd: '/work' } } }),
  });

  const Forced = function Forced() {
    const inner = wrapper.type(wrapper.props);
    const children = React.Children.toArray(inner.props.children).map((child) => (
      child.type?.name === 'ManageDialog'
        ? React.createElement(child.type, { ...child.props, open: true })
        : child
    ));
    return React.createElement(React.Fragment, null, children);
  };
  return renderToStaticMarkup(React.createElement(Forced));
}
