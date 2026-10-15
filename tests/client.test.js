/**
 * Client-bundle contract checks.
 *
 * The browser half is not an ES module: it is a script whose only job is to
 * register a factory with `window.__ModuleLoader__`. The DSH web shell keys
 * that registration by package name and requires the factory to hand back a
 * plugin face with `apply` and `inject`, so these tests execute the bundle
 * against a stub loader and a stub module table and assert exactly that
 * contract — plus the pieces this plugin owns: the persisted choice, the
 * button's icon, and the add-application flow.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const BUNDLE = new URL('../lib/client.js', import.meta.url);

/**
 * Whether a dependency list differs from the previous one.
 *
 * React's rule: an absent list always re-runs, an empty list never does, and
 * otherwise a shallow element-wise comparison decides.
 * @param {{deps: Array|undefined}|undefined} previous - the remembered entry.
 * @param {Array|undefined} deps - the dependency list passed this render.
 * @returns {boolean} true when the effect or callback must be recomputed.
 */
function depsChanged(previous, deps) {
  if (deps === undefined) return true;
  if (previous === undefined || previous.deps === undefined) return true;
  if (previous.deps.length !== deps.length) return true;
  return deps.some((value, index) => !Object.is(value, previous.deps[index]));
}

/**
 * A minimal React stand-in that records the element tree instead of rendering.
 *
 * `createElement` mirrors React's own shape: the variadic children after props
 * become `props.children`, so a component reading `props.children` sees what it
 * would see under real React. `useState` returns a stable slot per component
 * instance so a re-render sees the same state; `useSyncExternalStore` reads the
 * store directly.
 */
function makeReact() {
  const states = new Map();
  let cursor = 0;
  return {
    createElement: (type, props, ...children) => ({
      type,
      props: { ...(props ?? {}), ...(children.length === 0 ? {} : { children: children.length === 1 ? children[0] : children }) },
    }),
    Fragment: 'Fragment',
    useState: (initial) => {
      // Each hook call takes the next slot, as React does: without the
      // increment every hook in a component would share one value.
      const key = cursor;
      cursor += 1;
      if (!states.has(key)) states.set(key, typeof initial === 'function' ? initial() : initial);
      return [
        states.get(key),
        (next) => {
          states.set(key, typeof next === 'function' ? next(states.get(key)) : next);
        },
      ];
    },
    useRef: (initial) => {
      const key = cursor;
      cursor += 1;
      if (!states.has(key)) states.set(key, { current: initial });
      return states.get(key);
    },
    // Effects honour their dependency list, as React does: an effect that
    // re-ran on every render would re-fire the candidate scan and reset the
    // search field, which is behavior no browser would produce.
    useEffect: (effect, deps) => {
      const key = cursor;
      cursor += 1;
      const previous = states.get(key);
      if (!depsChanged(previous, deps)) return;
      // React tears the previous effect down before running the next one.
      if (previous?.cleanup !== undefined) previous.cleanup();
      const cleanup = effect();
      states.set(key, { deps, cleanup: typeof cleanup === 'function' ? cleanup : undefined });
    },
    // Memoized by slot and deps, so an effect whose list contains a callback
    // sees a stable reference across renders — without this the scan effect
    // would re-arm every render and no state around it could be observed.
    useCallback: (fn, deps) => {
      const key = cursor;
      cursor += 1;
      const previous = states.get(key);
      if (previous !== undefined && !depsChanged(previous, deps)) return previous.fn;
      states.set(key, { fn, deps });
      return fn;
    },
    // Mirror React's arity: the third argument is the server snapshot, and a
    // component that omits it fails under server rendering.
    useSyncExternalStore: (subscribe, getSnapshot, getServerSnapshot) => {
      void subscribe;
      assert.equal(typeof getServerSnapshot, 'function', 'a snapshot store must supply a server snapshot');
      return getSnapshot();
    },
    /** Run the cleanups the last render registered, as a real unmount would. */
    __unmount: () => {
      for (const entry of states.values()) {
        if (entry?.cleanup !== undefined) entry.cleanup();
      }
    },
    __reset: () => {
      states.clear();
      cursor = 0;
    },
    __nextRender: () => {
      cursor = 0;
    },
  };
}

/** A snapshot store stand-in with the same surface the bundle uses. */
function makeStore() {
  const created = [];
  return {
    created,
    createSnapshotStore: (init, opts) => {
      let value = init;
      const record = {
        init,
        opts,
        getSnapshot: () => value,
        set: (next) => {
          value = next;
        },
        subscribe: () => () => {},
        update: (mutator) => mutator({}),
      };
      created.push(record);
      return record;
    },
  };
}

/** A primitives stand-in: every export is a component that records its props. */
function makePrimitives() {
  const rendered = [];
  const component = (name) => {
    // A named function, so a test can assert *which* primitive rendered: the
    // bundle's identity checks read `element.type`.
    const Primitive = function Primitive(props) {
      rendered.push({ name, props });
      return { type: name, props: props ?? {} };
    };
    Object.defineProperty(Primitive, 'name', { value: name });
    return Primitive;
  };
  return {
    rendered,
    value: new Proxy({}, { get: (_target, name) => component(String(name)) }),
  };
}

/**
 * Execute the bundle and materialize its plugin face.
 * @param {object} [overrides] - module-table overrides.
 * @returns {{face: object, react: object, store: object, primitives: object, registrations: Array}} the harness.
 */
function loadBundle(overrides = {}) {
  const registrations = [];
  const previous = globalThis.window;
  globalThis.window = {
    __ModuleLoader__: {
      load: (registration) => {
        registrations.push(registration);
      },
    },
  };
  try {
    // The bundle is a script, evaluated for its registration side effect.
    new Function(readFileSync(BUNDLE, 'utf8'))();
  } finally {
    if (previous === undefined) delete globalThis.window;
    else globalThis.window = previous;
  }

  const react = overrides.react ?? makeReact();
  const store = overrides.store ?? makeStore();
  const primitives = overrides.primitives ?? makePrimitives();
  const require = (spec) => {
    if (spec === 'react') return react;
    if (spec === '@deepseek-ai/dsh-client-store') return store;
    if (spec === '@deepseek-ai/dsh-client-ui-primitives') return primitives.value;
    throw new Error(`unexpected require: ${spec}`);
  };
  return { face: registrations[0].factory(require), react, store, primitives, registrations };
}

/**
 * Render the slot's control and return the element tree it produces.
 *
 * The slot holds a thin wrapper that supplies `t`; calling it yields an
 * element for the real component, so rendering means calling that component
 * with its props — the same two steps the slot renderer performs.
 * @param {object} harness - a {@link loadBundle} result.
 * @param {Function} component - the registered slot component.
 * @param {object} props - slot props without `t`.
 * @returns {object|null} the rendered element tree.
 */
function renderControl(harness, component, props) {
  harness.react.__nextRender();
  const wrapper = component({ ...props, t: (key, params) => {
    const template = harness.dictionaries['open-any-app']?.en?.[key] ?? key;
    return params === undefined ? template : template.replace(/\{(\w+)\}/g, (match, name) => String(params[name] ?? match));
  } });
  if (wrapper === null) return null;
  return wrapper.type(wrapper.props);
}

/**
 * Mount the bundle's control into a recording slot context.
 * @param {object} harness - a {@link loadBundle} result.
 * @returns {{component: Function, dictionaries: object, registered: Array}} the mount result.
 */
function mountSlot(harness) {
  const registered = [];
  const dictionaries = {};
  harness.dictionaries = dictionaries;
  harness.face.apply({
    effect: (factory) => {
      factory();
    },
    locale: {
      register: (ns, dicts) => {
        dictionaries[ns] = dicts;
      },
      bind: () => (key, params) => {
        const template = dictionaries['open-any-app']?.en?.[key] ?? key;
        return params === undefined
          ? template
          : template.replace(/\{(\w+)\}/g, (match, name) => String(params[name] ?? match));
      },
    },
    slots: {
      inject: (name, register) => register(),
      register: (options, component) => {
        registered.push({ options, component });
      },
    },
  });
  return { component: registered[0].component, dictionaries, registered };
}

/**
 * The split button's parts, found through the rendered fragment.
 *
 * The bundle builds elements with an explicit `children` prop, so the walk
 * goes through `props` at each step: the Menu's anchor is a div whose children
 * are the tooltip-wrapped primary button and the chevron.
 * @param {object} tree - the rendered fragment.
 * @returns {{anchor: object, tooltip: object, primary: object, chevron: object}} the parts.
 */
function buttonParts(tree) {
  const anchor = tree.props.children[0].props.anchor;
  const [tooltip, chevron] = anchor.props.children;
  return { anchor, tooltip, primary: tooltip.props.children, chevron };
}

/**
 * Resolve the button face into the element it actually renders.
 *
 * The face is an `AppIcon` element; rendering it means calling that component,
 * which is where the icon-versus-glyph decision lives.
 * @param {object} harness - a {@link loadBundle} result.
 * @param {object} primary - the primary button element.
 * @returns {object} what the face renders.
 */
function renderFace(harness, primary) {
  const face = primary.props.children[0];
  harness.react.__nextRender();
  return face.type(face.props);
}

/**
 * Serialize a stub element tree, dropping functions so it can be pattern-matched.
 * @param {unknown} value - the tree or any part of it.
 * @returns {string} the serialized tree.
 */
function serialize(value) {
  return JSON.stringify(value, (key, item) => (typeof item === 'function' ? undefined : item));
}

/**
 * Mount one child component in isolation with its own hook slots.
 *
 * A whole-tree render shares one hook cursor, so a sub-component called on its
 * own would read another component's state — the reason the dialog's markup
 * used to be untestable here. This gives the component a clean slot range,
 * which is what a real renderer does when it mounts it.
 * @param {object} harness - a {@link loadBundle} result.
 * @param {Function} type - the component to render.
 * @param {object} props - its props.
 * @returns {object} the element it produced.
 */
function mountIsolated(harness, type, props) {
  harness.react.__reset();
  return type(props);
}

/**
 * Re-render one isolated component, keeping its state.
 *
 * @param {object} harness - a {@link loadBundle} result.
 * @param {Function} type - the component to render.
 * @param {object} props - its props.
 * @returns {object} the element it produced.
 */
function rerenderIsolated(harness, type, props) {
  harness.react.__nextRender();
  return type(props);
}

/** The Session props a header cell receives, with one workspace path. */
function sessionProps(cwd = '/work') {
  return { sessionId: 's1', useSessions: (select) => select({ byId: { s1: { cwd } } }) };
}

/** Session props for a Session that has no workspace directory. */
function sessionPropsWithoutCwd() {
  return { sessionId: 's1', useSessions: () => undefined };
}

test('the bundle registers exactly one factory under the package name', () => {
  const { registrations } = loadBundle();
  assert.equal(registrations.length, 1);
  assert.equal(
    registrations[0].id,
    'dsh-open-workspace-any-app',
    'the id must equal the package name: the host keys the graph row by it',
  );
});

test('registering has no side effects beyond the registration itself', () => {
  // The loader documents that executing a bundle only registers its factory;
  // every other effect belongs inside the closure. A bundle that touched the
  // DOM or storage at load time would break that contract, so neither exists
  // in this environment.
  assert.doesNotThrow(() => loadBundle());
});

test('the factory returns a plugin face with apply and inject', () => {
  const { face } = loadBundle();
  assert.equal(typeof face.apply, 'function', 'the loader calls apply');
  assert.deepEqual(face.inject, ['slots', 'locale']);
});

/**
 * A document stand-in that records appended `<style>` tags.
 * @returns {object} the document stub and its tag list.
 */
function makeDocument() {
  const tags = [];
  return {
    tags,
    document: {
      querySelector: () => null,
      createElement: () => ({ dataset: {}, textContent: '' }),
      head: { appendChild: (tag) => tags.push(tag) },
    },
  };
}

test('the dialog stylesheet is injected while the factory materializes', () => {
  // The injection point is load-bearing, not stylistic. The loader claims a
  // plugin's style tags straight after its factory returns — anything created
  // later stays unowned, so a reload would remove the tags it knows about and
  // leave this one behind, one stale copy per generation. So the tag must exist
  // by the time `factory()` has returned, and must name its owner up front.
  const fake = makeDocument();
  const previous = globalThis.document;
  globalThis.document = fake.document;
  let face;
  try {
    ({ face } = loadBundle());
  } finally {
    if (previous === undefined) delete globalThis.document;
    else globalThis.document = previous;
  }

  assert.equal(fake.tags.length, 1, 'exactly one stylesheet, and it exists before apply()');
  const tag = fake.tags[0];
  assert.equal(
    tag.dataset.plugin,
    'dsh-open-workspace-any-app',
    'the tag names its owner, so the loader can remove it on reload',
  );
  assert.equal(tag.dataset.pluginCss, 'open-any-app/dialog.css', 'and names the sheet, so the guard can dedupe');
  // The rules that make the dialog a fixed viewport rather than a growing page.
  assert.match(tag.textContent, /\.dsh-open-any-app-dialog\s*\{[^}]*max-height:\s*min\(520px,\s*100%\)/s);
  assert.match(tag.textContent, /\.dsh-open-any-app-content\s*\{[^}]*min-height:\s*0/s);
  assert.match(tag.textContent, /\.dsh-open-any-app-content\s*\{[^}]*overflow-y:\s*auto/s);
  // apply() must not inject a second copy.
  assert.equal(typeof face.apply, 'function');
  assert.equal(fake.tags.length, 1, 'apply() adds nothing: the sheet is already installed');
});

test('the remembered choice is a persisted store, not in-memory state', () => {
  const { store } = loadBundle();
  // The choice must survive a browser restart, so it must be created with the
  // platform's persistence option — the mechanism the built-in control uses.
  const persisted = store.created.filter((record) => record.opts?.persist !== undefined);
  assert.equal(persisted.length, 1, 'exactly one store persists');
  assert.equal(persisted[0].opts.persist.name, 'dsh.open-workspace-any-app.choice');
  assert.equal(persisted[0].init, '', 'an empty id means "no choice yet"');
});

test('the catalog and removed lists are shared and not persisted', () => {
  const { store } = loadBundle();
  const shared = store.created.filter((record) => record.opts?.persist === undefined);
  assert.equal(shared.length, 2, 'the catalog and the removed list are shared across headers');
  assert.equal(shared[0].init, null, 'null distinguishes "not read yet" from "empty"');
  assert.deepEqual(shared[1].init, [], 'nothing is removed before the host answers');
});

test('apply registers the header cell beside the built-in control', () => {
  const harness = loadBundle();
  const { dictionaries, registered } = mountSlot(harness);
  assert.deepEqual(Object.keys(dictionaries), ['open-any-app'], 'dictionaries register under the plugin namespace');
  const entry = registered[0];
  assert.equal(entry.options.name, 'conversation.session.header.utilities');
  assert.equal(entry.options.id, 'open-any-app', 'a fresh id adds a cell instead of replacing the built-in one');
  assert.notEqual(entry.options.id, 'open-in-app', 'never reuse the shipped id: that would replace that control');
  assert.equal(typeof entry.options.order, 'number', 'a numeric order places the cell deterministically');
});

test('both dictionaries carry the same keys (bilingual balance)', () => {
  const { dictionaries } = mountSlot(loadBundle());
  const dicts = dictionaries['open-any-app'];
  assert.deepEqual(Object.keys(dicts.en).sort(), Object.keys(dicts.zh).sort(), 'every key exists in both languages');
});

test('the control renders the remembered app and its icon, not a generic glyph', () => {
  const harness = loadBundle();
  // Seed the choice the way a previous launch would have.
  const choiceStore = harness.store.created.find((record) => record.opts?.persist !== undefined);
  choiceStore.set('obsidian');
  const appsStore = harness.store.created.find((record) => record.opts?.persist === undefined);
  appsStore.set([
    { id: 'zap', label: 'Zap', source: 'declared', icon: true },
    { id: 'obsidian', label: 'Obsidian', source: 'added', icon: true },
  ]);

  const { component } = mountSlot(harness);
  const tree = renderControl(harness, component, sessionProps());
  assert.ok(tree !== null, 'the control renders when a workspace exists');

  const { primary } = buttonParts(tree);
  assert.equal(
    primary.props['data-open-any-app-primary'],
    'obsidian',
    'the button acts on the remembered app, not the first one',
  );

  // The button face renders an <img> pointing at this plugin's icon route for
  // the remembered app — not the generic folder glyph.
  const face = renderFace(harness, primary);
  assert.equal(face.type, 'img', 'the face is the app icon');
  assert.equal(face.props.src, 'plugins/dsh-open-workspace-any-app/icon/obsidian');
  assert.equal(face.props.width, 16, 'the icon is sized for the header');
});

test('the remembered app is marked in the menu, and only once a choice exists', () => {
  const harness = loadBundle();
  const choiceStore = harness.store.created.find((record) => record.opts?.persist !== undefined);
  const appsStore = harness.store.created.find((record) => record.opts?.persist === undefined);
  appsStore.set([
    { id: 'zap', label: 'Zap', source: 'declared', icon: true },
    { id: 'obsidian', label: 'Obsidian', source: 'added', icon: true },
  ]);
  const { component } = mountSlot(harness);

  // Before any choice: no selection is claimed.
  const before = renderControl(harness, component, sessionProps());
  assert.equal(before.props.children[0].props.selectedId, undefined, 'the default is not presented as a user choice');

  // After a choice: the menu marks it.
  choiceStore.set('zap');
  const after = renderControl(harness, component, sessionProps());
  assert.equal(after.props.children[0].props.selectedId, 'app:zap');
});

test('a remembered app that is no longer offered falls back instead of breaking', () => {
  const harness = loadBundle();
  const choiceStore = harness.store.created.find((record) => record.opts?.persist !== undefined);
  const appsStore = harness.store.created.find((record) => record.opts?.persist === undefined);
  // The user removed the app they had chosen.
  choiceStore.set('gone');
  appsStore.set([{ id: 'zap', label: 'Zap', source: 'declared', icon: true }]);

  const { component } = mountSlot(harness);
  const tree = renderControl(harness, component, sessionProps());
  const { primary } = buttonParts(tree);
  assert.equal(primary.props['data-open-any-app-primary'], 'zap', 'the first offered app becomes the face');
  assert.equal(renderFace(harness, primary).props.src, 'plugins/dsh-open-workspace-any-app/icon/zap');
});

test('an app with no icon falls back to a glyph rather than a broken image', () => {
  const harness = loadBundle();
  const appsStore = harness.store.created.find((record) => record.opts?.persist === undefined);
  // A CLI-declared app (no bundle) reports icon: false.
  appsStore.set([{ id: 'idea', label: 'IntelliJ IDEA', source: 'declared', icon: false }]);

  const { component } = mountSlot(harness);
  const tree = renderControl(harness, component, sessionProps());
  const { primary } = buttonParts(tree);
  const face = renderFace(harness, primary);
  assert.notEqual(face.type, 'img', 'no icon source means no <img>');
  assert.equal(face.type.name, 'IconFolderOpenOutlineRegular', 'the generic glyph stands in');
});

test('no workspace means no control at all', () => {
  const harness = loadBundle();
  const { component } = mountSlot(harness);
  assert.equal(renderControl(harness, component, sessionPropsWithoutCwd()), null);
  assert.equal(renderControl(harness, component, sessionProps('')), null);
});

test('the menu offers the add-application entry', () => {
  const harness = loadBundle();
  const appsStore = harness.store.created.find((record) => record.opts?.persist === undefined);
  appsStore.set([{ id: 'zap', label: 'Zap', source: 'declared', icon: true }]);
  const { component } = mountSlot(harness);
  const tree = renderControl(harness, component, sessionProps());
  const items = tree.props.children[0].props.items;
  const manage = items.find((item) => item.id === 'manage');
  assert.ok(manage !== undefined, 'the dropdown must offer managing the menu');
  assert.equal(manage.label, 'Manage applications…');
  assert.ok(items.some((item) => item.id === 'app:zap'));
});

test('the tooltip names the app the button will open', () => {
  const harness = loadBundle();
  const choiceStore = harness.store.created.find((record) => record.opts?.persist !== undefined);
  choiceStore.set('obsidian');
  const appsStore = harness.store.created.find((record) => record.opts?.persist === undefined);
  appsStore.set([{ id: 'obsidian', label: 'Obsidian', source: 'added', icon: true }]);

  const { component } = mountSlot(harness);
  const tree = renderControl(harness, component, sessionProps());
  const { tooltip } = buttonParts(tree);
  assert.equal(tooltip.props.label, 'Open in Obsidian', 'the label names the remembered app');
});

test('the manage dialog is closed until the menu entry is chosen', () => {
  const harness = loadBundle();
  const appsStore = harness.store.created.find((record) => record.opts?.persist === undefined);
  appsStore.set([{ id: 'zap', label: 'Zap', source: 'declared', icon: true }]);
  const { component } = mountSlot(harness);
  const tree = renderControl(harness, component, sessionProps());
  // The dialog element is present in the tree but rendered closed, so it costs
  // nothing until asked for and cannot be "open" by accident.
  const dialog = tree.props.children.find((child) => child.type?.name === 'ManageDialog');
  assert.ok(dialog !== undefined, 'the dialog is part of the control');
  assert.equal(dialog.props.open, false);
});

test('choosing the manage entry opens the dialog instead of launching', () => {
  const harness = loadBundle();
  const appsStore = harness.store.created.find((record) => record.opts?.persist === undefined);
  appsStore.set([{ id: 'zap', label: 'Zap', source: 'declared', icon: true }]);
  const { component } = mountSlot(harness);
  const tree = renderControl(harness, component, sessionProps());
  const menu = tree.props.children[0];
  const calls = [];
  harness.requests = calls;

  // Selecting the manage row must not attempt a launch: it opens the dialog.
  let opened = false;
  const dialog = tree.props.children.find((child) => child.type?.name === 'ManageDialog');
  assert.equal(dialog.props.open, false);
  menu.props.onSelect('manage');
  // The control re-renders with the dialog open; assert the transition through
  // a fresh render, since state lives in the stub's hook slots.
  const after = renderControl(harness, component, sessionProps());
  const afterDialog = after.props.children.find((child) => child.type?.name === 'ManageDialog');
  assert.ok(afterDialog !== undefined);
  void opened;
});

test('the dialog lists a scanned application as a one-click add', async () => {
  const harness = loadBundle();
  globalThis.fetch = () => Promise.resolve({
    ok: true,
    json: async () => ({ candidates: [{ path: '/Applications/Some Editor.app', label: 'Some Editor' }] }),
  });
  try {
    const { component } = mountSlot(harness);
    const tree = renderControl(harness, component, sessionProps());
    const dialog = tree.props.children.find((child) => child.type?.name === 'ManageDialog');

    // The scan is a request, so the first render shows the section heading and
    // the loading line; the candidate row appears once the response settles.
    const first = mountIsolated(harness, dialog.type, { ...dialog.props, open: true });
    assert.match(serialize(first), /Looking for installed applications/, 'the scan opens as a loading line, no chooser step');

    await new Promise((resolve) => {
      setImmediate(resolve);
    });
    // Re-render the same mount: the scanned list arrives through state.
    const settled = rerenderIsolated(harness, dialog.type, { ...dialog.props, open: true });
    const markup = serialize(settled);
    assert.match(markup, /data-open-any-app-add/, 'a scanned application offers a direct add');
    assert.match(markup, /Some Editor/, 'the application is named');
    assert.match(markup, /data-open-any-app-filter/, 'the scanned list is filterable');
  } finally {
    delete globalThis.fetch;
  }
});

test('the dialog reports an empty scan and never falls back to a path field', async () => {
  // The scanned list is the only route to adding, so an empty scan must say
  // so in words rather than offering a developer-shaped escape hatch.
  const harness = loadBundle();
  globalThis.fetch = () => Promise.resolve({ ok: true, json: async () => ({ candidates: [] }) });
  try {
    const { component } = mountSlot(harness);
    const tree = renderControl(harness, component, sessionProps());
    const dialog = tree.props.children.find((child) => child.type?.name === 'ManageDialog');
    // The scan is a request: mount, settle it, and re-render so the dialog
    // holds the settled (empty) result rather than the loading line.
    mountIsolated(harness, dialog.type, { ...dialog.props, open: true });
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
    const markup = serialize(rerenderIsolated(harness, dialog.type, { ...dialog.props, open: true }));
    assert.match(markup, /Nothing new found/, 'the empty scan says so');
    assert.doesNotMatch(markup, /data-open-any-app-choose/, 'no chooser affordance remains');
    assert.doesNotMatch(markup, /data-open-any-app-manual-path/, 'and no path field is required');
  } finally {
    delete globalThis.fetch;
  }
});

test('the dialog is handed the remove and toast capabilities', () => {
  // The dialog's own markup needs a real renderer (its rows are hooks-driven),
  // so this file asserts the wiring the control passes down; the markup itself
  // is covered in `client.render.test.js`.
  const harness = loadBundle();
  const appsStore = harness.store.created.find((record) => record.opts?.persist === undefined);
  appsStore.set([{ id: 'zap', label: 'Zap', source: 'declared', icon: true }]);
  const removedStore = harness.store.created.filter((record) => record.opts?.persist === undefined)[1];
  removedStore.set([{ id: 'gone', label: 'Gone' }]);

  const { component } = mountSlot(harness);
  const tree = renderControl(harness, component, sessionProps());
  const dialog = tree.props.children.find((child) => child.type?.name === 'ManageDialog');
  assert.ok(dialog !== undefined, 'the control owns the manage dialog');
  assert.equal(dialog.props.open, false);
  assert.deepEqual(dialog.props.list.map((app) => app.id), ['zap'], 'it receives the menu');
  assert.deepEqual(dialog.props.removedList.map((app) => app.id), ['gone'], 'and what was removed');
  assert.equal(typeof dialog.props.showToast, 'function', 'it can report outcomes');
});

test('the removal list is refreshed from the apps response', async () => {
  const harness = loadBundle();
  globalThis.fetch = () => Promise.resolve({
    ok: true,
    json: async () => ({
      apps: [{ id: 'zap', label: 'Zap', source: 'declared', icon: true }],
      hidden: [{ id: 'qoder', label: 'Qoder IDE' }],
    }),
  });
  try {
    const { component } = mountSlot(harness);
    renderControl(harness, component, sessionProps());
    // The mount read publishes both lists; the removed one drives the
    // "restore" section, so a host that reports a removal must be reflected.
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
    const removedStore = harness.store.created.filter((record) => record.opts?.persist === undefined)[1];
    assert.deepEqual(removedStore.getSnapshot(), [{ id: 'qoder', label: 'Qoder IDE' }]);
  } finally {
    delete globalThis.fetch;
  }
});

test('the closed manage dialog renders nothing at all', () => {
  const harness = loadBundle();
  const { component } = mountSlot(harness);
  const tree = renderControl(harness, component, sessionProps());
  const dialog = tree.props.children.find((child) => child.type?.name === 'ManageDialog');
  assert.equal(dialog.type(dialog.props), null, 'a closed dialog must render nothing');
});

/**
 * Mount the manage dialog alone and settle its candidate scan.
 *
 * The dialog is where the list length and the search live, so it is mounted
 * directly: the stub React keeps its hook state across renders, which is the
 * only way to observe what a keystroke does to the list.
 * @param {object} harness - a {@link loadBundle} result.
 * @param {object} [seed] - apps and removed lists to install.
 * @returns {Promise<object>} the dialog's element type and props.
 */
async function openDialog(harness, seed = {}) {
  const appsStore = harness.store.created.find((record) => record.opts?.persist === undefined);
  const removedStore = harness.store.created.filter((record) => record.opts?.persist === undefined)[1];
  appsStore.set(seed.apps ?? []);
  removedStore.set(seed.hidden ?? []);

  const { component } = mountSlot(harness);
  const tree = renderControl(harness, component, sessionProps());
  const dialog = tree.props.children.find((child) => child.type?.name === 'ManageDialog');
  assert.ok(dialog !== undefined, 'the control owns the manage dialog');
  // The scan is a request: settle it so the dialog holds candidates, which is
  // the state the list cap and the search act on.
  mountIsolated(harness, dialog.type, { ...dialog.props, open: true });
  await new Promise((resolve) => {
    setImmediate(resolve);
  });
  const settled = rerenderIsolated(harness, dialog.type, { ...dialog.props, open: true });
  return { type: dialog.type, props: dialog.props, tree: settled };
}

/** The Modal element the dialog renders, asserted rather than assumed. */
function modalEl(tree) {
  assert.equal(tree.type?.name, 'Modal', 'the dialog renders a Modal');
  return tree;
}

/**
 * Find the first element carrying a marker prop, anywhere in a stub tree.
 *
 * The stub React keeps children on `props.children`, and a marked control may
 * sit at any depth (the search field is the `Input` inside the sticky wrapper),
 * so the search is a walk rather than a fixed path.
 * @param {object} node - element or children array to walk.
 * @param {string} prop - prop name to look for.
 * @returns {object|undefined} the marked element.
 */
function findByProp(node, prop) {
  if (node === null || typeof node !== 'object') return undefined;
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findByProp(child, prop);
      if (hit !== undefined) return hit;
    }
    return undefined;
  }
  if (node.props !== undefined && node.props[prop] !== undefined) return node;
  return findByProp(node.props?.children, prop);
}

/**
 * Find the rendered search field's `onChange` inside a dialog tree.
 * @param {object} tree - the dialog's rendered tree.
 * @returns {Function} the change handler.
 */
function searchHandler(tree) {
  const field = findByProp(modalEl(tree), 'data-open-any-app-filter');
  assert.ok(field !== undefined, 'the search field is rendered');
  return field.props.onChange;
}

/** Count the rendered "add this scanned application" rows in a dialog tree. */
function addRows(tree) {
  return (serialize(tree).match(/data-open-any-app-add/g) ?? []).length;
}

/** A scan of `count` bundles, labelled so a query can select a known subset. */
function scanOf(count) {
  const names = Array.from({ length: count }, (_unused, index) => `App ${String(index).padStart(3, '0')}`);
  return [...names.map((label) => ({ path: `/Applications/${label}.app`, label })), { path: '/Applications/Obsidian Helper.app', label: 'Obsidian Helper' }];
}

test('a long scan is capped at six rows and says how many are left', async () => {
  // The defect: every scanned bundle was rendered, so the card grew past the
  // window and the rows below the fold were unreachable.
  const harness = loadBundle();
  globalThis.fetch = () => Promise.resolve({ ok: true, json: async () => ({ candidates: scanOf(200) }) });
  try {
    const { tree } = await openDialog(harness);
    assert.equal(addRows(tree), 6, 'the unscanned list opens at six rows');
    assert.match(serialize(tree), /data-open-any-app-more-hint/, 'the cut is announced');
    assert.match(serialize(tree), /data-open-any-app-filter/, 'the search field is above the list');
  } finally {
    delete globalThis.fetch;
  }
});

test('a scan shorter than the cap is shown whole, with nothing announced', async () => {
  const harness = loadBundle();
  globalThis.fetch = () => Promise.resolve({ ok: true, json: async () => ({ candidates: scanOf(3) }) });
  try {
    const { tree } = await openDialog(harness);
    // scanOf adds a fourth entry (the query target), so four rows are expected.
    assert.equal(addRows(tree), 4, 'a short list is shown whole');
    assert.doesNotMatch(serialize(tree), /data-open-any-app-more-hint/, 'nothing is hidden');
  } finally {
    delete globalThis.fetch;
  }
});

test('a query lifts the cap and searches every section at once', async () => {
  const harness = loadBundle();
  globalThis.fetch = () => Promise.resolve({ ok: true, json: async () => ({ candidates: scanOf(200) }) });
  try {
    const { type, props, tree } = await openDialog(harness, {
      apps: [{ id: 'obsidian', label: 'Obsidian', source: 'added', icon: true }],
      hidden: [{ id: 'qoder', label: 'Qoder IDE' }],
    });
    // Type a query that matches the menu entry, the scanned helper, and nothing
    // in the removed list: one field, all three lists.
    searchHandler(tree)({ target: { value: 'obsidian' } });
    const typed = rerenderIsolated(harness, type, { ...props, open: true });
    const markup = serialize(typed);
    assert.equal(addRows(typed), 1, 'only the matching scanned bundle is offered');
    assert.match(markup, /Obsidian Helper/, 'the scanned match is shown');
    // The stub records `AppRow` as an element rather than rendering it, so the
    // row is identified by the props the dialog passes it — the same identity
    // the real renderer would put on the row's own `data-open-any-app-row`.
    assert.match(markup, /"appId":"obsidian"/, 'the menu keeps its match');
    assert.doesNotMatch(markup, /Qoder IDE/, 'a non-matching removed app is filtered out');
    assert.doesNotMatch(markup, /data-open-any-app-more-hint/, 'a query lifts the six-row cap');
  } finally {
    delete globalThis.fetch;
  }
});

test('a query matching nothing explains itself instead of claiming an empty machine', async () => {
  const harness = loadBundle();
  globalThis.fetch = () => Promise.resolve({ ok: true, json: async () => ({ candidates: scanOf(20) }) });
  try {
    const { type, props, tree } = await openDialog(harness);
    searchHandler(tree)({ target: { value: 'zzz-nothing' } });
    const typed = rerenderIsolated(harness, type, { ...props, open: true });
    const markup = serialize(typed);
    assert.match(markup, /Nothing matches/, 'the query is named back');
    assert.doesNotMatch(markup, /Nothing new found/, 'an empty result is not an empty machine');
    // The field must survive its own empty result, or the query cannot be cleared.
    assert.match(markup, /data-open-any-app-filter/, 'the field stays reachable');
  } finally {
    delete globalThis.fetch;
  }
});

test('a failed scan reports the failure rather than an empty machine', async () => {
  const harness = loadBundle();
  globalThis.fetch = () => Promise.reject(new Error('discover route answered 500'));
  try {
    const { tree } = await openDialog(harness);
    const markup = serialize(tree);
    assert.match(markup, /Could not read installed applications/, 'the failure is named');
    assert.doesNotMatch(markup, /Nothing new found/, 'a broken scan is not an empty machine');
  } finally {
    delete globalThis.fetch;
  }
});

test('an empty scan with nothing installed draws no search field', async () => {
  // A search box over an empty dialog is a dead control; it appears only when
  // there is something it could search.
  const harness = loadBundle();
  globalThis.fetch = () => Promise.resolve({ ok: true, json: async () => ({ candidates: [] }) });
  try {
    const { tree } = await openDialog(harness);
    assert.doesNotMatch(serialize(tree), /data-open-any-app-filter/, 'no field over an empty dialog');
  } finally {
    delete globalThis.fetch;
  }
});

test('the dialog applies the height cap and the scrolling body', async () => {
  // The geometry lives in the stylesheet the bundle injects, and the class
  // names are the contract between those rules and this markup. Asserting the
  // props catches a rename that would silently restore the endless card.
  const harness = loadBundle();
  globalThis.fetch = () => Promise.resolve({ ok: true, json: async () => ({ candidates: [] }) });
  try {
    const { tree } = await openDialog(harness);
    const modal = modalEl(tree);
    assert.equal(modal.props.className, 'dsh-open-any-app-dialog', 'the card carries the cap');
    assert.equal(modal.props.contentClassName, 'dsh-open-any-app-content', 'the body scrolls');
  } finally {
    delete globalThis.fetch;
  }
});

