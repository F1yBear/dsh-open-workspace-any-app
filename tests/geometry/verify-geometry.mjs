/**
 * Geometric verification of the manage dialog's fixed viewport.
 *
 * Why this exists separately from the unit tests: the defect this covers is
 * *geometric*. A card that renders 200 rows at `max-height: none` is not wrong
 * in any element tree — every attribute is correct — it is wrong in a layout
 * engine. `node --test` has no layout engine, so the assertions that matter
 * ("the card fits the window", "the body scrolls", "the footer is on screen")
 * can only be made by a browser.
 *
 * This script therefore measures the real thing in headless Chrome:
 *
 * - the design tokens, extracted from the installed DSH's own theme package;
 * - the real `Modal` and `Input` stylesheets, extracted from the installed
 *   `@deepseek-ai/dsh-client-ui-primitives`;
 * - the stylesheet the plugin bundle actually injects, obtained by executing
 *   `lib/client.js` and calling its `apply()`;
 * - the DOM shape the bundle renders, rebuilt from the same primitives' markup.
 *
 * Nothing here is a hand-written imitation of the product's CSS, because imitating
 * it would verify the imitation rather than the product.
 *
 * Opt-in, not part of `npm test`: it needs Chrome and an installed DSH, and it
 * measures a layout rather than exercising logic. Run it with
 * `npm run verify:geometry` after changing the dialog's styles.
 *
 * ## One trap worth recording
 *
 * `--dump-dom` captures the DOM *before* asynchronous frames run, so measuring
 * inside a `requestAnimationFrame` chain silently reports the pre-scroll layout —
 * which once made a working `position: sticky` look broken. Every measurement
 * below is synchronous, with a forced reflow (`void el.offsetHeight`) between a
 * scroll and the read that follows it.
 * @module dsh-open-workspace-any-app/tests/geometry
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** Installed application whose internals are measured, in probe order. */
const APP_CANDIDATES = [
  '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar',
  `${process.env.HOME ?? ''}/Applications/DeepSeek Harness.app/Contents/Resources/app.asar`,
];

/** Chrome binaries, in probe order. */
const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
];

/** The card's cap, in px: `min(520px, 100%)` in the injected stylesheet. */
const CARD_CAP = 520;

/**
 * Read the asar header, correctly.
 *
 * The JSON header is padded to a 4-byte boundary, so file data begins at
 * `16 + align4(headerSize)` — not `16 + headerSize`. Getting that wrong yields
 * files with a leading byte or two of the next structure, which is enough to
 * make a browser drop the first rule of every stylesheet and report a cap that
 * does not work. That mistake cost real time here; hence the assertion below.
 * @param {string} path - the `.asar` archive.
 * @returns {{header: object, dataStart: number, read: Function}} the archive reader.
 */
function openAsar(path) {
  const bytes = readFileSync(path);
  const headerSize = bytes.readUInt32LE(12);
  const dataStart = 16 + headerSize + ((4 - (headerSize % 4)) % 4);
  const header = JSON.parse(bytes.subarray(16, 16 + headerSize).toString('utf8'));

  const walk = function* walk(node, prefix = '') {
    for (const [name, value] of Object.entries(node.files ?? {})) {
      const current = `${prefix}/${name}`;
      if (value.files !== undefined) yield* walk(value, current);
      else yield [current, value];
    }
  };
  const index = new Map(walk(header));

  return {
    header,
    dataStart,
    /**
     * Read one member of the archive.
     * @param {string} member - absolute member path.
     * @returns {string} its UTF-8 contents.
     */
    read(member) {
      const entry = index.get(member);
      if (entry === undefined) throw new Error(`asar member not found: ${member}`);
      const start = dataStart + Number(entry.offset);
      return bytes.subarray(start, start + entry.size).toString('utf8');
    },
  };
}

/**
 * The stylesheet the plugin injects, captured from the bundle itself.
 *
 * The bundle is executed against a stub loader and a stub module table; its
 * `apply()` is then called so the stylesheet is written into the fake
 * `document`, exactly as it is in a browser.
 * @param {string} bundlePath - `lib/client.js`.
 * @returns {string} the injected CSS text.
 */
function pluginStylesheet(bundlePath) {
  const registrations = [];
  const tags = [];
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  globalThis.window = { __ModuleLoader__: { load: (registration) => registrations.push(registration) } };
  globalThis.document = {
    querySelector: () => null,
    createElement: () => ({ dataset: {}, textContent: '' }),
    head: { appendChild: (tag) => tags.push(tag) },
  };
  try {
    // eslint-disable-next-line no-new-func -- the bundle is a script, not a module.
    new Function(readFileSync(bundlePath, 'utf8'))();
    const stub = new Proxy({}, { get: () => () => null });
    const react = {
      createElement: () => ({}),
      Fragment: 'Fragment',
      useState: () => [null, () => {}],
      useEffect: () => {},
      useRef: () => ({ current: null }),
      useCallback: (fn) => fn,
      useSyncExternalStore: () => null,
    };
    const store = { createSnapshotStore: () => ({ subscribe: () => () => {}, getSnapshot: () => null, set: () => {} }) };
    const face = registrations[0].factory((spec) => {
      if (spec === 'react') return react;
      if (spec === '@deepseek-ai/dsh-client-store') return store;
      return stub;
    });
    face.apply({
      effect: (factory) => factory(),
      locale: { register: () => {}, bind: () => () => '' },
      slots: { inject: (_name, register) => register(), register: () => {} },
    });
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
  const css = tags[0]?.textContent ?? '';
  if (!css.includes('.dsh-open-any-app-dialog')) throw new Error('the bundle injected no dialog stylesheet');
  return css;
}

/**
 * Rename a CSS module's class names onto the readable names the probe page uses.
 * @param {string} css - the stylesheet text.
 * @param {Record<string, string>} map - source class name to probe class name.
 * @returns {string} the renamed stylesheet.
 */
function rename(css, map) {
  let out = css;
  for (const [from, to] of Object.entries(map)) {
    out = out.replaceAll(new RegExp(`\\.${from}\\b`, 'gu'), `.${to}`);
  }
  return out;
}

/**
 * Build the probe page: real tokens, real primitive CSS, real dialog DOM.
 * @param {object} parts - the stylesheets and row count to embed.
 * @returns {string} the HTML.
 */
function probeHtml(parts) {
  const rows = (count, hint) => Array.from({ length: count }, (_unused, index) => {
    const label = `App ${String(index).padStart(3, '0')}`;
    return `<div class="row" data-open-any-app-row="candidate:${label}"><span class="lbl">${label}</span><span data-open-any-app-add=""></span></div>`;
  }).join('') + (hint ? `<div class="dsh-open-any-app-more-hint" data-open-any-app-more-hint="">${count} more</div>` : '');

  return `<!doctype html><html><head><meta charset="utf-8"><style>
${parts.tokens}
</style><style>
${parts.modal}
</style><style>
${parts.input}
</style><style>
${parts.plugin}
</style><style>
body{margin:0;font-family:var(--dsw-font-family)}
.btn{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;height:36px;padding:0 14px;border:none;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-button-primary-fill)}
.row{display:flex;align-items:center;gap:8px;min-height:32px;padding:2px 2px 2px 8px;border-radius:var(--dsw-radius-sm)}
.row .lbl{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sec-h{font-size:11px;line-height:15px;color:var(--dsw-alias-label-tertiary);padding:0 8px 4px}
.sec{margin-top:14px}
</style></head><body>
<div class="modal-root"><div class="modal-mask"></div>
<div class="modal-dialog dsh-open-any-app-dialog" id="card">
  <div class="modal-content dsh-open-any-app-content" id="content">
    <div class="modal-header"><h2 class="modal-title">Applications</h2></div>
    <p class="modal-description">Choose which applications the menu offers.</p>
    <div class="modal-body" id="body">
      <div class="dsh-open-any-app-search" id="field"><span class="inp-wrap"><span class="inp-icon"></span><input class="inp" placeholder="Search applications…" data-open-any-app-filter></span></div>
      <div class="sec"><div class="sec-h">In the menu</div><div class="dsh-open-any-app-list">
        <div class="row" data-open-any-app-row="zap"><span class="lbl">Zap</span></div>
        <div class="row" data-open-any-app-row="qoder"><span class="lbl">Qoder IDE</span></div>
      </div></div>
      <div class="sec"><div class="sec-h">Found in Applications</div>
        <div class="dsh-open-any-app-list">${rows(parts.rows, parts.hint)}</div></div>
    </div>
  </div>
  <div class="modal-footer" id="footer"><button class="btn" style="background:transparent">Close</button></div>
</div></div>
<div id="report">measuring…</div>
<script>
const card=document.getElementById('card'), content=document.getElementById('content');
const field=document.getElementById('field');
const cs=getComputedStyle(card);
const r=card.getBoundingClientRect();
const f=r0=>Math.round(r0);
const out={
  viewport:[innerWidth,innerHeight],
  cardHeight:f(r.height),
  cardTop:f(r.top),
  cardBottom:f(r.bottom),
  maxHeight:cs.maxHeight,
  contentOverflowY:getComputedStyle(content).overflowY,
  contentMinHeight:getComputedStyle(content).minHeight,
  contentScrollHeight:content.scrollHeight,
  contentClientHeight:content.clientHeight,
  searchWidth:f(field.getBoundingClientRect().width),
  cardFitsViewport:r.top>=-0.5&&r.bottom<=innerHeight+0.5,
  footerVisible:(()=>{const b=document.getElementById('footer').getBoundingClientRect();return b.top>=0&&b.bottom<=innerHeight+0.5;})(),
  searchVisible:(()=>{const b=field.getBoundingClientRect();return b.top>=0&&b.bottom<=innerHeight+0.5;})(),
  scrollable:content.scrollHeight>content.clientHeight+1,
};
// Sticky, measured synchronously with a forced reflow between scroll and read:
// without the reflow the read returns the pre-scroll layout.
const before=f(field.getBoundingClientRect().top);
content.scrollTop=120; void content.offsetHeight;
const after=f(field.getBoundingClientRect().top);
// The claim the fix makes: however far the list scrolls, the field never
// leaves the container's top edge. When the scroll is shallow the field has
// not reached its sticking line yet and simply tracks the scroll — sitting
// above the sticking line *is* the correct sticky outcome, so the assertion
// is "still at the container top", not "a stick happened". (Deleting the
// chooser button shortened the six-row page: its whole scroll range no longer
// crosses the sticking line, which the old "a stick happened" form read as a
// regression.)
out.fieldPinned=after>=f(content.getBoundingClientRect().top)-1&&before>after;
content.scrollTop=0;
document.getElementById('report').textContent=JSON.stringify(out);
</script></body></html>`;
}

/**
 * Extract the DSH internals the probe needs, or explain why it cannot run.
 * @returns {{tokens: string, modal: string, input: string}|null} the stylesheets.
 */
function dshStylesheets() {
  const asar = APP_CANDIDATES.find((candidate) => existsSync(candidate));
  if (asar === undefined) return null;
  const archive = openAsar(asar);
  const modal = archive.read('/dsh/node_modules/@deepseek-ai/dsh-client-ui-primitives/lib/Modal.module.css');
  const input = archive.read('/dsh/node_modules/@deepseek-ai/dsh-client-ui-primitives/lib/Input.module.css');
  const theme = archive.read('/dsh/node_modules/@deepseek-ai/dsh-client-ui-theme/lib/client.js');

  // The theme ships its tokens as CSS string literals inside its client bundle;
  // the parser pulls those literals back out. Each must begin with a selector,
  // which is also the check that the archive offset above was right.
  const blocks = {};
  for (const match of theme.matchAll(/var (\w+_css_default) = "((?:[^"\\]|\\.)*)";/gu)) {
    blocks[match[1]] = match[2].replaceAll(/\\"/gu, '"').replaceAll('\\n', '\n');
  }
  const tokens = [blocks.base_css_default, blocks.design_platform_css_default, blocks.scrollbar_css_default].join('\n');
  if (!tokens.startsWith(':root{')) {
    throw new Error('theme tokens did not extract cleanly: the asar data offset is wrong');
  }
  return {
    tokens,
    modal: rename(modal, { root: 'modal-root', mask: 'modal-mask', dialog: 'modal-dialog', content: 'modal-content', header: 'modal-header', title: 'modal-title', close: 'modal-close', description: 'modal-description', body: 'modal-body', footer: 'modal-footer' }),
    input: rename(input, { wrap: 'inp-wrap', icon: 'inp-icon', input: 'inp' }),
  };
}

/** Launch headless Chrome on a page and return its report. */
async function measure(chrome, dir, html, name, size) {
  const page = join(dir, `${name}.html`);
  writeFileSync(page, html);
  // A dedicated user data dir per run: without one, Chrome refuses to start
  // while the operator's own Chrome holds the default profile lock.
  const profile = join(dir, `${name}-profile`);
  const { stdout } = await run(chrome, [
    '--headless', '--disable-gpu', '--no-sandbox',
    `--user-data-dir=${profile}`,
    `--window-size=${size}`,
    '--virtual-time-budget=4000',
    '--dump-dom',
    pathToFileURL(page).href,
  ], { maxBuffer: 32 * 1024 * 1024 });
  const match = /<div id="report">(.*?)<\/div>/su.exec(stdout);
  if (match === null) throw new Error(`no measurement captured for ${name}`);
  return JSON.parse(match[1].replaceAll('&quot;', '"'));
}

/**
 * Measure the dialog and report every claim the fix makes.
 * @returns {Promise<number>} process exit code.
 */
async function main() {
  const chrome = CHROME_CANDIDATES.find((candidate) => existsSync(candidate));
  if (chrome === undefined) {
    process.stdout.write('geometry: skipped — no Chrome found\n');
    return 0;
  }
  const dsh = dshStylesheets();
  if (dsh === null) {
    process.stdout.write('geometry: skipped — no installed DeepSeek Harness found\n');
    return 0;
  }

  const bundle = new URL('../../lib/client.js', import.meta.url);
  const plugin = pluginStylesheet(bundle);
  const dir = mkdtempSync(join(tmpdir(), 'oaa-geometry-'));
  const failures = [];

  /**
   * Assert one measured claim.
   * @param {string} name - the scenario.
   * @param {object} got - the measurement.
   * @param {(value: any) => boolean} ok - the expectation.
   * @param {string} claim - what the claim is, for the failure line.
   */
  const check = (name, got, ok, claim) => {
    const pass = ok(got);
    if (!pass) failures.push(`${name}: ${claim} (measured ${JSON.stringify(got)})`);
    process.stdout.write(`  ${pass ? 'ok  ' : 'FAIL'} ${name} — ${claim}\n`);
  };

  try {
    for (const scenario of [
      { name: 'capped-6-rows', rows: 6, hint: true, size: '1280,720' },
      { name: 'uncapped-150-rows', rows: 150, hint: false, size: '1280,720' },
      { name: 'short-window', rows: 6, hint: true, size: '900,420' },
      { name: 'very-short-window', rows: 6, hint: true, size: '1280,340' },
    ]) {
      const got = await measure(chrome, dir, probeHtml({ ...dsh, plugin, rows: scenario.rows, hint: scenario.hint }), scenario.name, scenario.size);
      process.stdout.write(`\n${scenario.name} (viewport ${got.viewport.join('x')})\n`);
      check(scenario.name, got.cardHeight, (value) => value <= CARD_CAP, `the card is capped at ${String(CARD_CAP)}px`);
      check(scenario.name, got, (value) => value.cardFitsViewport === true, 'the card fits inside the window');
      check(scenario.name, got, (value) => value.footerVisible === true, 'the dialog buttons stay on screen');
      check(scenario.name, got, (value) => value.searchVisible === true, 'the search field stays on screen');
      check(scenario.name, got, (value) => value.scrollable === true, 'the long list is reachable by scrolling');
      check(scenario.name, got, (value) => value.fieldPinned === true, 'the search field stays pinned while the list scrolls');
      check(scenario.name, got.contentMinHeight, (value) => value === '0px', 'the body may shrink, so the cap can bite');
      check(scenario.name, got.contentOverflowY, (value) => value === 'auto', 'the body owns the scrollbar');
      // The field must span the dialog rather than shrink to its placeholder.
      check(scenario.name, got.searchWidth, (value) => value > 200, 'the search field spans the dialog');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  if (failures.length > 0) {
    process.stderr.write(`\ngeometry: ${String(failures.length)} claim(s) failed\n`);
    for (const failure of failures) process.stderr.write(`  - ${failure}\n`);
    return 1;
  }
  process.stdout.write('\ngeometry: every claim holds\n');
  return 0;
}

process.exitCode = await main();
