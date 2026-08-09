/**
 * Git Repo Ingestion Extension — clone, walk, chunk, return nodes.
 *
 * Handles:
 * - Shallow clone of public repos
 * - File walking with ignore list
 * - Chunking all valid source/doc files into nodes
 * - Temp directory cleanup
 *
 * Usage: import { ingestRepo } from './ingest-repo.js'
 */
import { readFile, readdir, mkdir, rm } from "node:fs/promises";
import { join, extname } from "node:path";
import { chunkDocument } from "./ingest-file.js";

// === Default ignore list ===
const DEFAULT_IGNORES = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', 'target', 'vendor',
  '.next', '.nuxt', '.svelte-kit', '__pycache__', '.pytest_cache',
  'coverage', '.nyc_output', '.cache', '.parcel-cache',
  '.vscode', '.idea', '.kiro', '.DS_Store', '.env',
  'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'Cargo.lock',
  'go.sum', 'composer.lock', 'Gemfile.lock', 'poetry.lock',
  'bun.lockb', 'shrinkwrap.json'
]);

// === Valid file extensions ===
const VALID_EXTS = new Set([
  '.js', '.ts', '.jsx', '.tsx', '.mjs', '.cjs',
  '.py', '.rs', '.go', '.java', '.c', '.cpp', '.h', '.hpp',
  '.rb', '.php', '.swift', '.kt', '.scala', '.zig',
  '.md', '.txt', '.rst', '.adoc',
  '.yaml', '.yml', '.toml', '.json',
  '.css', '.scss', '.less',
  '.html', '.svelte', '.vue', '.astro',
  '.sh', '.bash', '.zsh', '.fish',
  '.sql', '.graphql', '.gql', '.proto'
]);

/**
 * Clone a public repo, walk files, chunk everything, return nodes.
 * Cleans up the temp directory when done.
 *
 * @param {string} repoUrl - public git clone URL
 * @param {string} dataDir - parent directory for temp clone
 * @param {string[]} [customIgnores] - additional names/patterns to skip
 * @returns {Promise<{nodes: Array<{heading: string, content: string}>, error?: string}>}
 */
export async function ingestRepo(repoUrl, dataDir, customIgnores = []) {
  const tempDir = join(dataDir, '_temp_repo_' + Date.now());
  await mkdir(tempDir, { recursive: true });

  // Build ignore set
  const ignores = new Set(DEFAULT_IGNORES);
  customIgnores.forEach(i => ignores.add(i));

  // Clone (shallow, single branch)
  const { execSync } = await import("node:child_process");
  try {
    execSync(`git clone --depth 1 --single-branch "${repoUrl}" "${tempDir}"`, {
      timeout: 90000,
      stdio: 'pipe'
    });
  } catch (err) {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    return { nodes: [], error: 'Git clone failed: ' + err.message };
  }

  const allChunks = [];

  async function walk(dir, relPath = '') {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); }
    catch { return; }

    for (const entry of entries) {
      if (entry.name.startsWith('.') && entry.name !== '.env.example') continue;
      if (ignores.has(entry.name)) continue;

      const fullPath = join(dir, entry.name);
      const rel = relPath ? relPath + '/' + entry.name : entry.name;

      if (entry.isDirectory()) {
        await walk(fullPath, rel);
      } else {
        const ext = extname(entry.name).toLowerCase();
        if (!VALID_EXTS.has(ext)) continue;

        try {
          const content = await readFile(fullPath, 'utf8');
          if (content.length < 30) continue;
          if (content.length > 50000) continue; // Skip huge generated files

          const fileChunks = chunkDocument(content, rel);
          allChunks.push(...fileChunks);
        } catch { /* skip binary/unreadable */ }
      }
    }
  }

  await walk(tempDir);

  // Clean up
  await rm(tempDir, { recursive: true, force: true }).catch(() => {});

  return { nodes: allChunks };
}
