/**
 * Memory Profiles Extension — Multiple named memory states with switching.
 *
 * Each profile is a complete, independent memory state (chain + BM25 index).
 * Profiles are stored as separate JSON files in the data/ directory.
 * Users can switch between them like workspaces.
 *
 * API (serve.js endpoints):
 *   GET  /api/profiles          → list all profiles
 *   POST /api/profiles/create   → create a new empty profile
 *   POST /api/profiles/switch   → switch active profile
 *   POST /api/profiles/delete   → delete a profile
 *   GET  /api/profiles/active   → get current active profile name
 *
 * File naming: data/memory-{profileName}.json
 * Active profile tracked in: data/active-profile.txt
 */
import { readFile, writeFile, readdir, unlink, stat } from "node:fs/promises";
import { join } from "node:path";

const PROFILE_PREFIX = 'memory-';
const PROFILE_SUFFIX = '.json';
const ACTIVE_FILE = 'active-profile.txt';

/**
 * List all available memory profiles.
 * @param {string} dataDir - path to data/ directory
 * @returns {Promise<Array<{name: string, size: number, nodeCount: number}>>}
 */
export async function listProfiles(dataDir) {
  const profiles = [];
  let entries;
  try { entries = await readdir(dataDir); } catch { return profiles; }

  for (const entry of entries) {
    if (entry.startsWith(PROFILE_PREFIX) && entry.endsWith(PROFILE_SUFFIX)) {
      const name = entry.slice(PROFILE_PREFIX.length, -PROFILE_SUFFIX.length);
      const filePath = join(dataDir, entry);
      try {
        const info = await stat(filePath);
        // Quick node count: read file and count chain nodes
        let nodeCount = 0;
        try {
          const data = JSON.parse(await readFile(filePath, 'utf8'));
          nodeCount = data.chain?.nodes?.length || 0;
        } catch { /* can't parse, show 0 */ }
        profiles.push({
          name,
          size: info.size,
          nodeCount
        });
      } catch { /* skip unreadable */ }
    }
  }

  return profiles;
}

/**
 * Get the currently active profile name.
 * @param {string} dataDir
 * @returns {Promise<string>} - profile name (default: 'state')
 */
export async function getActiveProfile(dataDir) {
  try {
    const name = (await readFile(join(dataDir, ACTIVE_FILE), 'utf8')).trim();
    return name || 'state';
  } catch {
    return 'state'; // Default profile
  }
}

/**
 * Set the active profile name.
 * @param {string} dataDir
 * @param {string} name
 */
export async function setActiveProfile(dataDir, name) {
  await writeFile(join(dataDir, ACTIVE_FILE), name, 'utf8');
}

/**
 * Get the file path for a given profile name.
 * @param {string} dataDir
 * @param {string} name
 * @returns {string}
 */
export function getProfilePath(dataDir, name) {
  return join(dataDir, PROFILE_PREFIX + name + PROFILE_SUFFIX);
}

/**
 * Create a new empty profile.
 * @param {string} dataDir
 * @param {string} name - profile name (alphanumeric + dashes)
 * @returns {Promise<{success: boolean, error?: string}>}
 */
export async function createProfile(dataDir, name) {
  if (!name || !/^[a-z0-9\-]+$/i.test(name)) {
    return { success: false, error: 'Invalid name. Use alphanumeric and dashes only.' };
  }

  const filePath = getProfilePath(dataDir, name);
  try {
    await stat(filePath);
    return { success: false, error: 'Profile "' + name + '" already exists.' };
  } catch { /* doesn't exist, good */ }

  // Write empty state
  const emptyState = { chain: { nodes: [], nextId: 1 }, bm25: { documents: {} } };
  await writeFile(filePath, JSON.stringify(emptyState, null, 2), 'utf8');
  return { success: true };
}

/**
 * Delete a profile.
 * @param {string} dataDir
 * @param {string} name
 * @returns {Promise<{success: boolean, error?: string}>}
 */
export async function deleteProfile(dataDir, name) {
  if (name === 'state') {
    return { success: false, error: 'Cannot delete the default profile.' };
  }

  const active = await getActiveProfile(dataDir);
  if (name === active) {
    return { success: false, error: 'Cannot delete the active profile. Switch to another first.' };
  }

  const filePath = getProfilePath(dataDir, name);
  try {
    await unlink(filePath);
    return { success: true };
  } catch (err) {
    return { success: false, error: 'Delete failed: ' + err.message };
  }
}
