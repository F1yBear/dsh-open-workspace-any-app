/**
 * Icon extraction for resolved applications.
 *
 * One strategy per declared source:
 *
 * - `iconPath` — an image file the operator named; served as-is with its
 *   media type taken from the extension.
 * - `iconBundle` (and, on macOS, an `app` locator's own bundle) — the bundle's
 *   `.icns`, converted to a 128px PNG through `plutil` + `sips`, the two
 *   tools every macOS install has. This mirrors the built-in extractor's
 *   approach without importing it.
 *
 * Every failure resolves null, and the icon route then answers 404, which the
 * browser renders as a generic glyph — an icon is decoration, never a reason
 * for a menu entry to disappear.
 * @module dsh-open-workspace-any-app/icons
 */
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';

/** Media type per extension for icons served straight from disk. */
const MEDIA_TYPES = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
  ['.svg', 'image/svg+xml'],
  ['.icns', 'image/icns'],
  ['.ico', 'image/x-icon'],
]);

/** Cache-busting window for an icon response; bundles change on reinstall, not per reload. */
export const ICON_CACHE_CONTROL = 'public, max-age=3600';

/**
 * Serve one icon file from disk as-is.
 * @param {string} path - absolute icon file path.
 * @returns {Promise<{bytes: Buffer, contentType: string}|null>} the icon, or null when unreadable.
 */
async function readIconFile(path) {
  try {
    const info = await stat(path);
    if (!info.isFile()) return null;
    const bytes = await readFile(path);
    return { bytes, contentType: MEDIA_TYPES.get(extname(path).toLowerCase()) ?? 'application/octet-stream' };
  } catch {
    // Swallows ENOENT/EACCES alike: an unreadable icon is simply no icon.
    return null;
  }
}

/**
 * Run one bounded command and return its stdout.
 * @param {string} command - tool name.
 * @param {string[]} args - argv.
 * @param {number} timeoutMs - deadline.
 * @returns {Promise<string|null>} stdout, or null on any failure.
 */
async function run(command, args, timeoutMs) {
  const { execFile } = await import('node:child_process');
  return await new Promise((resolve) => {
    execFile(command, args, { timeout: timeoutMs, encoding: 'utf8' }, (error, stdout) => {
      resolve(error === null || error === undefined ? stdout : null);
    });
  });
}

/**
 * Extract one macOS bundle's icon as a 128px PNG.
 *
 * `CFBundleIconFile` names the `.icns` and may omit the extension; a bundle
 * that declares nothing falls back to the first `Resources/*.icns`. The
 * conversion writes to a fresh temp directory so a failure leaves nothing
 * behind.
 * @param {string} bundlePath - absolute `.app` path.
 * @param {number} timeoutMs - per-command deadline.
 * @returns {Promise<{bytes: Buffer, contentType: string}|null>} the PNG, or null.
 */
async function extractBundleIcon(bundlePath, timeoutMs) {
  const resources = join(bundlePath, 'Contents', 'Resources');
  let iconFile = null;

  const plist = await run('plutil', ['-convert', 'json', '-o', '-', join(bundlePath, 'Contents', 'Info.plist')], timeoutMs);
  if (plist !== null) {
    try {
      const declared = JSON.parse(plist).CFBundleIconFile;
      if (typeof declared === 'string' && declared !== '') {
        iconFile = declared.endsWith('.icns') ? declared : `${declared}.icns`;
      }
    } catch {
      // Swallows malformed plutil output: the Resources scan below still applies.
    }
  }
  if (iconFile === null) {
    try {
      iconFile = (await readdir(resources)).find((entry) => entry.endsWith('.icns')) ?? null;
    } catch {
      // Swallows a missing Resources directory: such a bundle has no icon.
      return null;
    }
  }
  if (iconFile === null) return null;

  const icns = join(resources, iconFile);
  try {
    if (!(await stat(icns)).isFile()) return null;
  } catch {
    // Swallows ENOENT: Info.plist may name an icon file that is not on disk.
    return null;
  }

  const workDir = await mkdtemp(join(tmpdir(), 'dsh-open-workspace-any-app-'));
  try {
    const out = join(workDir, 'icon.png');
    // `-Z 128` fits the largest side into 128px, preserving aspect ratio.
    const converted = await run('sips', ['-s', 'format', 'png', '-Z', '128', icns, '--out', out], timeoutMs);
    if (converted === null) return null;
    try {
      return { bytes: await readFile(out), contentType: 'image/png' };
    } catch {
      // Swallows a sips run that exited 0 without writing its output.
      return null;
    }
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

/**
 * Extract one resolved application's icon.
 * @param {import('./resolver.js').ResolvedLaunch} resolved - a verified launcher.
 * @param {number} timeoutMs - per-command deadline.
 * @returns {Promise<{bytes: Buffer, contentType: string}|null>} the icon, or null when none is available.
 */
export async function extractAppIcon(resolved, timeoutMs) {
  if (resolved.iconPath !== null) {
    const direct = await readIconFile(resolved.iconPath);
    if (direct !== null) return direct;
  }
  if (resolved.iconBundle === null) return null;
  return await extractBundleIcon(resolved.iconBundle, timeoutMs);
}

/** Exported for tests: the individual strategies, without a resolved entry. */
export const __testing = { readIconFile, extractBundleIcon, run };
