/**
 * Discovery of installed applications that the plugin does not yet offer.
 *
 * The "add an application" flow must not ask a person to type
 * `/Applications/Some App.app` from memory: the bundles that can be opened
 * are exactly the ones already installed, so the host enumerates them and the
 * dialog offers them as choices. A manual path entry stays available for
 * anything the scan cannot see (a bundle outside the application roots, a
 * CLI-only launcher).
 * @module dsh-open-workspace-any-app/discover
 */
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

/** Application roots scanned for bundles, in offering order. */
export const APPLICATION_ROOTS = ['/Applications', '/System/Applications'];

/** Cap on offered candidates: a bound keeps the response small and the dialog scannable. */
export const MAX_CANDIDATES = 200;

/** A macOS application bundle's extension. */
const BUNDLE_SUFFIX = '.app';

/**
 * Derive the display label for one bundle file name.
 *
 * The store keeps the `.app` name only for the path; the label drops the
 * extension because every candidate is an application bundle.
 * @param {string} entry - bundle directory name, e.g. `Qoder IDE.app`.
 * @returns {string} the label to show.
 */
export function labelFromBundle(entry) {
  const withoutSuffix = entry.endsWith(BUNDLE_SUFFIX) ? entry.slice(0, -BUNDLE_SUFFIX.length) : entry;
  return withoutSuffix === '' ? entry : withoutSuffix;
}

/**
 * Scan one root for application bundles.
 * @param {string} root - absolute directory to scan.
 * @returns {Promise<string[]>} bundle directory names, or an empty list when the root is unreadable.
 */
async function bundlesIn(root) {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && entry.name.endsWith(BUNDLE_SUFFIX))
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));
  } catch {
    // Swallows ENOENT/EACCES: a root this install does not have contributes nothing.
    return [];
  }
}

/**
 * Collect installed application candidates, excluding what is already offered.
 *
 * `offered` carries both the ids and the bundle paths already in the menu, so
 * a declared entry and a previously added one are both filtered out — the
 * dialog offers only what adding would actually change.
 * @param {object} options - scan inputs.
 * @param {string[]} [options.roots] - roots to scan; defaults to the macOS application roots.
 * @param {Set<string>} options.offeredPaths - absolute bundle paths already offered.
 * @param {number} [options.limit] - cap on returned candidates.
 * @returns {Promise<{candidates: Array<{path: string, label: string}>, truncated: boolean}>} the scan result.
 */
export async function discoverApps({ roots = APPLICATION_ROOTS, offeredPaths, limit = MAX_CANDIDATES }) {
  const candidates = [];
  let truncated = false;
  for (const root of roots) {
    for (const entry of await bundlesIn(root)) {
      const path = join(root, entry);
      if (offeredPaths.has(path)) continue;
      if (candidates.length >= limit) {
        truncated = true;
        break;
      }
      candidates.push({ path, label: labelFromBundle(entry) });
    }
    if (truncated) break;
  }
  return { candidates, truncated };
}
