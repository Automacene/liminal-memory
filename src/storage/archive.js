/**
 * Archive Manager — cold storage for trimmed/branched data.
 * Uses IndexedDB in browser, or an in-memory Map fallback for Node.js/testing.
 * Data only goes here on explicit user trim/branch operations.
 */
export class Archive {
  constructor() {
    this.db = null;
    this.fallbackStore = new Map(); // In-memory fallback for non-browser environments
    this.useIndexedDB = typeof indexedDB !== "undefined";
  }

  /**
   * Initialize the archive store.
   */
  async init() {
    if (!this.useIndexedDB) return;

    return new Promise((resolve, reject) => {
      const request = indexedDB.open("luminal-memory-archive", 1);

      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains("blocks")) {
          db.createObjectStore("blocks", { keyPath: "key" });
        }
      };

      request.onsuccess = (event) => {
        this.db = event.target.result;
        resolve();
      };

      request.onerror = (event) => {
        console.warn("IndexedDB unavailable, using in-memory fallback");
        this.useIndexedDB = false;
        resolve();
      };
    });
  }

  /**
   * Store a compressed archive block.
   * @param {string} key - archive identifier (e.g., "archive_501_1500")
   * @param {object[]} nodes - array of node objects to archive
   */
  async store(key, nodes) {
    const json = JSON.stringify(nodes);
    const compressed = await compress(json);
    const block = {
      key,
      data: compressed,
      createdAt: Date.now(),
      nodeCount: nodes.length,
      sizeBytes: compressed.byteLength || compressed.length
    };

    if (this.useIndexedDB && this.db) {
      return new Promise((resolve, reject) => {
        const tx = this.db.transaction("blocks", "readwrite");
        tx.objectStore("blocks").put(block);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } else {
      this.fallbackStore.set(key, block);
    }
  }

  /**
   * Retrieve and decompress an archive block.
   * @param {string} key
   * @returns {object[]|null} array of nodes, or null if not found
   */
  async retrieve(key) {
    let block;

    if (this.useIndexedDB && this.db) {
      block = await new Promise((resolve, reject) => {
        const tx = this.db.transaction("blocks", "readonly");
        const request = tx.objectStore("blocks").get(key);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    } else {
      block = this.fallbackStore.get(key);
    }

    if (!block) return null;

    const json = await decompress(block.data);
    return JSON.parse(json);
  }

  /**
   * Delete an archive block.
   * @param {string} key
   */
  async delete(key) {
    if (this.useIndexedDB && this.db) {
      return new Promise((resolve, reject) => {
        const tx = this.db.transaction("blocks", "readwrite");
        tx.objectStore("blocks").delete(key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } else {
      this.fallbackStore.delete(key);
    }
  }

  /**
   * List all stored archive keys.
   * @returns {string[]}
   */
  async list() {
    if (this.useIndexedDB && this.db) {
      return new Promise((resolve, reject) => {
        const tx = this.db.transaction("blocks", "readonly");
        const request = tx.objectStore("blocks").getAllKeys();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    } else {
      return Array.from(this.fallbackStore.keys());
    }
  }

  /**
   * Export all archives (for full state export).
   * @returns {object[]}
   */
  async exportAll() {
    if (this.useIndexedDB && this.db) {
      return new Promise((resolve, reject) => {
        const tx = this.db.transaction("blocks", "readonly");
        const request = tx.objectStore("blocks").getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    } else {
      return Array.from(this.fallbackStore.values());
    }
  }

  /**
   * Import archives from exported data.
   * @param {object[]} blocks
   */
  async importAll(blocks) {
    for (const block of blocks) {
      if (this.useIndexedDB && this.db) {
        await new Promise((resolve, reject) => {
          const tx = this.db.transaction("blocks", "readwrite");
          tx.objectStore("blocks").put(block);
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        });
      } else {
        this.fallbackStore.set(block.key, block);
      }
    }
  }
}

/**
 * Compress a string using CompressionStream (browser) or raw encoding fallback.
 * @param {string} text
 * @returns {ArrayBuffer|string}
 */
async function compress(text) {
  if (typeof CompressionStream !== "undefined") {
    const encoder = new TextEncoder();
    const stream = new Blob([encoder.encode(text)])
      .stream()
      .pipeThrough(new CompressionStream("gzip"));
    const blob = await new Response(stream).blob();
    return await blob.arrayBuffer();
  }
  // Fallback: store uncompressed (still works, just bigger)
  return text;
}

/**
 * Decompress data back to string.
 * @param {ArrayBuffer|string} data
 * @returns {string}
 */
async function decompress(data) {
  if (typeof data === "string") return data;

  if (typeof DecompressionStream !== "undefined") {
    const stream = new Blob([data])
      .stream()
      .pipeThrough(new DecompressionStream("gzip"));
    const blob = await new Response(stream).blob();
    return await blob.text();
  }

  // Fallback: try to decode as raw text
  const decoder = new TextDecoder();
  return decoder.decode(data);
}
