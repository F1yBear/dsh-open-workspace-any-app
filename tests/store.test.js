/**
 * The store: what the UI added, what it removed, and how both merge into the
 * menu.
 *
 * Every test writes inside a fresh temporary directory, never the operator's
 * real `~/.dsh` tree.
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { Config, hiddenApps, mergeCatalog } from '../lib/config.js';
import {
  addUserApp,
  readStore,
  readUserApps,
  removeUserApp,
  resolveDshHome,
  restoreUserApp,
  slugify,
  storePath,
  uniqueId,
  writeStore,
} from '../lib/store.js';

/**
 * Run a body against a fresh temporary directory.
 * @param {(dir: string) => Promise<void>} body - the test body.
 * @returns {Promise<void>} resolves after the directory is removed.
 */
async function withTempDir(body) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-open-any-app-store-'));
  try {
    await body(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** A config with the given declared applications. */
function configWith(declared = []) {
  return Config({ apps: declared });
}

test('a missing store reads as empty rather than failing', async () => {
  await withTempDir(async (dir) => {
    assert.deepEqual(await readStore(join(dir, 'nope.json')), { apps: [], hidden: [] });
  });
});

test('a written store round-trips both lists', async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, 'apps.json');
    const document = {
      apps: [{ id: 'zap', label: 'Zap', path: '/Applications/Zap.app' }],
      hidden: ['obsidian'],
    };
    await writeStore(path, document);
    assert.deepEqual(await readStore(path), document);
    assert.deepEqual(await readUserApps(path), document.apps, 'readUserApps reads the additions only');
    assert.equal(JSON.parse(await readFile(path, 'utf8')).version, 2);
  });
});

test('a version-1 store is upgraded, not discarded', async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, 'apps.json');
    // v1 held a bare apps array and had no way to record a removal.
    await writeFile(path, JSON.stringify({
      version: 1,
      apps: [{ id: 'zap', label: 'Zap', path: '/Applications/Zap.app' }],
    }), 'utf8');
    assert.deepEqual(await readStore(path), {
      apps: [{ id: 'zap', label: 'Zap', path: '/Applications/Zap.app' }],
      hidden: [],
    });
  });
});

test('a malformed store reads as empty instead of breaking the menu', async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, 'apps.json');
    await writeFile(path, 'not json at all', 'utf8');
    assert.deepEqual(await readStore(path), { apps: [], hidden: [] });
  });
});

test('a store from an unknown future version reads as empty', async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, 'apps.json');
    await writeFile(path, JSON.stringify({ version: 99, apps: [{ id: 'x', label: 'X', path: '/x' }] }), 'utf8');
    assert.deepEqual(await readStore(path), { apps: [], hidden: [] });
  });
});

test('malformed entries inside a valid store are dropped, not fatal', async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, 'apps.json');
    await writeFile(path, JSON.stringify({
      version: 2,
      apps: [
        { id: 'good', label: 'Good', path: '/Applications/Good.app' },
        { id: 'no-path', label: 'Nope' },
        null,
        'string',
        { id: '', label: 'Blank', path: '/x' },
      ],
      hidden: ['gone', '', 42, null],
    }), 'utf8');
    assert.deepEqual(await readStore(path), {
      apps: [{ id: 'good', label: 'Good', path: '/Applications/Good.app' }],
      hidden: ['gone'],
    });
  });
});

test('a missing label falls back to the id rather than rendering blank', async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, 'apps.json');
    await writeFile(path, JSON.stringify({ version: 2, apps: [{ id: 'x', path: '/Applications/X.app' }], hidden: [] }), 'utf8');
    assert.deepEqual(await readUserApps(path), [{ id: 'x', label: 'x', path: '/Applications/X.app' }]);
  });
});

test('slugify produces ids the config schema accepts', () => {
  // The id addresses the launch request and the icon URL, so it must match the
  // schema's id pattern; a label of pure punctuation must not yield "".
  assert.equal(slugify('Qoder IDE'), 'qoder-ide');
  assert.equal(slugify('Zap.app'), 'zap');
  assert.equal(slugify('HBuilderX'), 'hbuilderx');
  assert.equal(slugify('Visual Studio Code'), 'visual-studio-code');
  assert.equal(slugify('!!!'), 'app');
  assert.equal(slugify('  '), 'app');
  assert.match(slugify('认识汉字'), /^[a-z0-9][a-z0-9._-]*$|^app$/u);
});

test('uniqueId avoids collisions without changing a free stem', () => {
  assert.equal(uniqueId('zap', []), 'zap');
  assert.equal(uniqueId('zap', ['zap']), 'zap-2');
  assert.equal(uniqueId('zap', ['zap', 'zap-2']), 'zap-3');
});

test('adding replaces a same-id or same-path entry instead of duplicating', () => {
  const empty = { apps: [], hidden: [] };
  const first = addUserApp(empty, { id: 'zap', label: 'Zap', path: '/Applications/Zap.app' });
  const relabelled = addUserApp(first, { id: 'zap', label: 'Zap Terminal', path: '/Applications/Zap.app' });
  assert.deepEqual(relabelled.apps, [{ id: 'zap', label: 'Zap Terminal', path: '/Applications/Zap.app' }]);

  // Re-adding the same bundle under a fresh id must also replace, so one
  // bundle is never offered twice.
  const again = addUserApp(relabelled, { id: 'zap-2', label: 'Zap', path: '/Applications/Zap.app' });
  assert.deepEqual(again.apps, [{ id: 'zap-2', label: 'Zap', path: '/Applications/Zap.app' }]);
});

test('adding clears any removal of that id', () => {
  // "Add" always makes the app visible: that is what the person just asked for.
  const added = addUserApp({ apps: [], hidden: ['zap'] }, { id: 'zap', label: 'Zap', path: '/Applications/Zap.app' });
  assert.deepEqual(added.hidden, [], 'a re-added app must not stay hidden');
});

test('removing records the id and drops any stored entry for it', () => {
  const document = {
    apps: [
      { id: 'a', label: 'A', path: '/A' },
      { id: 'b', label: 'B', path: '/B' },
    ],
    hidden: [],
  };
  const after = removeUserApp(document, 'a');
  assert.deepEqual(after.apps, [{ id: 'b', label: 'B', path: '/B' }]);
  assert.deepEqual(after.hidden, ['a']);
});

test('removing a declared id records it without holding an entry', () => {
  // This is what makes a config-declared app removable: the removal is a fact
  // about the menu, and the operator's document is never rewritten.
  assert.deepEqual(removeUserApp({ apps: [], hidden: [] }, 'qoder'), { apps: [], hidden: ['qoder'] });
});

test('removing twice is idempotent', () => {
  const once = removeUserApp({ apps: [], hidden: [] }, 'a');
  assert.deepEqual(removeUserApp(once, 'a').hidden, ['a']);
});

test('restoring clears the removal without inventing an entry', () => {
  assert.deepEqual(restoreUserApp({ apps: [], hidden: ['qoder'] }, 'qoder'), { apps: [], hidden: [] });
  // Restoring something that is not hidden is a no-op, not corruption.
  assert.deepEqual(restoreUserApp({ apps: [], hidden: [] }, 'nope'), { apps: [], hidden: [] });
});

test('resolveDshHome prefers $DSH_HOME, ignores a blank one', () => {
  assert.equal(resolveDshHome({ DSH_HOME: '/custom/home' }, '/home/u'), '/custom/home');
  assert.equal(resolveDshHome({ DSH_HOME: '   ' }, '/home/u'), '/home/u/.dsh');
  assert.equal(resolveDshHome({}, '/home/u'), '/home/u/.dsh');
});

test('storePath honors an explicit directory over the harness home', () => {
  assert.equal(storePath({}, '/home/u'), '/home/u/.dsh/open-workspace-any-app/apps.json');
  assert.equal(storePath({}, '/home/u', '/tmp/isolated'), '/tmp/isolated/apps.json');
});

test('an added app becomes an ordinary catalog entry after the declared ones', () => {
  const config = configWith([{ id: 'zap', label: 'Zap', locators: [{ kind: 'app', paths: ['/Applications/Zap.app'] }] }]);
  const merged = mergeCatalog(config, {
    apps: [{ id: 'obsidian', label: 'Obsidian', path: '/Applications/Obsidian.app' }],
    hidden: [],
  }, 'darwin');
  assert.deepEqual(merged.map((app) => app.id), ['zap', 'obsidian'], 'declared order is preserved');
  assert.equal(merged[1].source, 'added');
  assert.deepEqual(merged[1].locators, [{ kind: 'app', paths: ['/Applications/Obsidian.app'], args: [] }]);
  assert.equal(merged[1].launch, 'open', 'a macOS bundle opens by identity');
});

test('an added app whose bundle the operator already declared is dropped', () => {
  const config = configWith([{ id: 'zap', label: 'Zap', locators: [{ kind: 'app', paths: ['/Applications/Zap.app'] }] }]);
  const merged = mergeCatalog(config, {
    apps: [{ id: 'zap-2', label: 'Zap', path: '/Applications/Zap.app' }],
    hidden: [],
  }, 'darwin');
  assert.deepEqual(merged.map((app) => app.id), ['zap']);
});

test('an added app reusing a declared id is dropped rather than shadowing it', () => {
  const config = configWith([{ id: 'zap', label: 'Declared Zap', locators: [{ kind: 'app', paths: ['/Applications/Zap.app'] }] }]);
  const merged = mergeCatalog(config, {
    apps: [{ id: 'zap', label: 'Sneaky', path: '/Applications/Other.app' }],
    hidden: [],
  }, 'darwin');
  assert.deepEqual(merged.map((app) => app.label), ['Declared Zap'], 'the hand-written row wins');
});

test('a declared app can be hidden, which is how a config entry is removed', () => {
  // The reported defect: apps the profile ships declared could not be removed.
  const config = configWith([
    { id: 'qoder', label: 'Qoder IDE', locators: [{ kind: 'app', paths: ['/Applications/Qoder IDE.app'] }] },
    { id: 'zap', label: 'Zap', locators: [{ kind: 'app', paths: ['/Applications/Zap.app'] }] },
  ]);
  const merged = mergeCatalog(config, { apps: [], hidden: ['qoder'] }, 'darwin');
  assert.deepEqual(merged.map((app) => app.id), ['zap'], 'the declared app is gone from the menu');
  // The config itself is untouched: hiding is a separate document.
  assert.deepEqual(config.apps.map((app) => app.id), ['qoder', 'zap']);
});

test('a hidden declared app is offered back by hiddenApps', () => {
  const config = configWith([
    { id: 'qoder', label: 'Qoder IDE', locators: [{ kind: 'app', paths: ['/Applications/Qoder IDE.app'] }] },
  ]);
  assert.deepEqual(
    hiddenApps(config, { apps: [], hidden: ['qoder'] }, 'darwin'),
    [{ id: 'qoder', label: 'Qoder IDE' }],
  );
});

test('a hidden added app is offered back too, and disappears from the additions', () => {
  const stored = {
    apps: [{ id: 'obsidian', label: 'Obsidian', path: '/Applications/Obsidian.app' }],
    hidden: ['obsidian'],
  };
  assert.deepEqual(mergeCatalog(configWith(), stored, 'darwin'), []);
  assert.deepEqual(hiddenApps(configWith(), stored, 'darwin'), [{ id: 'obsidian', label: 'Obsidian' }]);
});

test('a hidden id nothing offers is simply forgotten', () => {
  // A removal outlives the app it names; it must not appear as a restorable
  // entry, because there would be nothing to restore.
  const stored = { apps: [], hidden: ['long-gone'] };
  assert.deepEqual(hiddenApps(configWith(), stored, 'darwin'), []);
  assert.deepEqual(mergeCatalog(configWith(), stored, 'darwin'), []);
});

test('mergeCatalog labels every entry with its source', () => {
  const config = configWith([{ id: 'a', label: 'A', locators: [] }]);
  const merged = mergeCatalog(config, {
    apps: [{ id: 'b', label: 'B', path: '/B.app' }],
    hidden: [],
  }, 'darwin');
  assert.deepEqual(merged.map((app) => app.source), ['declared', 'added']);
});
