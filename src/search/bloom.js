/**
 * d-Left Counting Bloom Filter
 * Supports insertion, membership testing, and deletion.
 * Pure JavaScript, zero dependencies.
 *
 * Uses two sub-tables (d=2) with 4-bit counters per bucket.
 * Each item is hashed into both tables; inserted into the less-loaded one.
 */
export class BloomFilter {
  constructor(config = {}) {
    const expectedItems = config.expectedItems || 100000;
    const fpRate = config.falsePositiveRate || 0.01;

    // Calculate optimal size
    this.size = Math.ceil(-(expectedItems * Math.log(fpRate)) / (Math.log(2) ** 2));
    this.hashCount = Math.ceil((this.size / expectedItems) * Math.log(2));

    // Two sub-tables for d-left hashing, each with counters
    this.tableSize = Math.ceil(this.size / 2);
    this.left = new Uint8Array(this.tableSize);   // 4-bit counters packed in bytes
    this.right = new Uint8Array(this.tableSize);

    this.itemCount = 0;
  }

  /**
   * Add a term associated with a block.
   * @param {string} term
   */
  add(term) {
    const h = this._hashes(term);
    const leftLoad = this.left[h.left % this.tableSize];
    const rightLoad = this.right[h.right % this.tableSize];

    // Insert into less-loaded side (d-left strategy)
    if (leftLoad <= rightLoad) {
      const idx = h.left % this.tableSize;
      if (this.left[idx] < 255) this.left[idx]++;
    } else {
      const idx = h.right % this.tableSize;
      if (this.right[idx] < 255) this.right[idx]++;
    }
    this.itemCount++;
  }

  /**
   * Test if a term might exist in any archived block.
   * @param {string} term
   * @returns {boolean} true = possibly present, false = definitely not present
   */
  test(term) {
    const h = this._hashes(term);
    const leftVal = this.left[h.left % this.tableSize];
    const rightVal = this.right[h.right % this.tableSize];
    return leftVal > 0 || rightVal > 0;
  }

  /**
   * Remove (decrement) a term. Used when restoring an archive block.
   * @param {string} term
   */
  remove(term) {
    const h = this._hashes(term);
    const leftIdx = h.left % this.tableSize;
    const rightIdx = h.right % this.tableSize;

    // Decrement from both sides if non-zero (safe approach)
    if (this.left[leftIdx] > 0) {
      this.left[leftIdx]--;
      this.itemCount--;
    } else if (this.right[rightIdx] > 0) {
      this.right[rightIdx]--;
      this.itemCount--;
    }
  }

  /**
   * Add all terms from a text block.
   * @param {string} text
   */
  addText(text) {
    const terms = uniqueTerms(text);
    for (const term of terms) {
      this.add(term);
    }
    return terms.length;
  }

  /**
   * Remove all terms from a text block.
   * @param {string} text
   */
  removeText(text) {
    const terms = uniqueTerms(text);
    for (const term of terms) {
      this.remove(term);
    }
  }

  /**
   * Test which query terms might exist in archives.
   * @param {string} query
   * @returns {boolean} true if any query term might be in archives
   */
  testQuery(query) {
    const terms = uniqueTerms(query);
    for (const term of terms) {
      if (this.test(term)) return true;
    }
    return false;
  }

  /**
   * Generate hash pair for a term using FNV-1a variants.
   * @param {string} term
   * @returns {{ left: number, right: number }}
   */
  _hashes(term) {
    return {
      left: fnv1a(term, 0x811c9dc5),
      right: fnv1a(term, 0x01000193)
    };
  }

  /**
   * Reset the filter.
   */
  clear() {
    this.left.fill(0);
    this.right.fill(0);
    this.itemCount = 0;
  }

  /**
   * Export filter state.
   */
  export() {
    return {
      size: this.size,
      hashCount: this.hashCount,
      tableSize: this.tableSize,
      left: Array.from(this.left),
      right: Array.from(this.right),
      itemCount: this.itemCount
    };
  }

  /**
   * Import filter state.
   */
  import(data) {
    this.size = data.size;
    this.hashCount = data.hashCount;
    this.tableSize = data.tableSize;
    this.left = new Uint8Array(data.left);
    this.right = new Uint8Array(data.right);
    this.itemCount = data.itemCount;
  }
}

/**
 * FNV-1a hash with configurable seed.
 * Returns a positive 32-bit integer.
 * @param {string} str
 * @param {number} seed
 * @returns {number}
 */
function fnv1a(str, seed) {
  let hash = seed;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % 0x7FFFFFFF;
}

/**
 * Extract unique lowercase terms from text.
 * @param {string} text
 * @returns {string[]}
 */
function uniqueTerms(text) {
  if (!text) return [];
  const terms = text
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter(t => t.length > 1);
  return [...new Set(terms)];
}
