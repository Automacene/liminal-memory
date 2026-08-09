/**
 * Liminal Memory, deterministic recall over a pool of nodes.
 *
 * Language models have two problems with long conversations. The obvious one is capacity: the
 * window fills and older material falls out. The less obvious one is that a bigger window does
 * not fix it, because the model still has to locate the relevant part on its own, softly and
 * unpredictably. This library takes the finding step out of the model. Keep your content as
 * nodes, search them with ordinary relevance math, hand the model only what matched.
 *
 * It manages the lifecycle of those nodes and nothing else. What a node holds, how it gets
 * tagged, and how the graph works are yours, each with a working default.
 */
import { Pool } from "./pool.js";
import { BM25_DEFAULTS } from "./search/bm25.js";
import { KEYWORD_DEFAULTS } from "./tag/keywords.js";

/**
 * Re-stated here so the published types carry them, and so `Node` doesn't resolve to the
 * browser's `Node` in any file that mentions it.
 * @typedef {import("./node.js").Node} Node
 * @typedef {import("./node.js").NodeMetadata} NodeMetadata
 */

/**
 * A container of named pools.
 *
 * Most programs need one pool and never think about the concept. Reach straight for
 * `create`, `get`, and the rest, and they act on the default pool. Reach for `pool(name)` when
 * you have genuinely different kinds of node that shouldn't share a search index, such as
 * conversation turns alongside document chunks.
 */
export class LiminalMemory {
  /**
   * @param {object} [options]
   * @param {string} [options.defaultPool]  name of the pool the shorthand methods use
   * @param {() => number} [options.now]  clock, defaults to `Date.now`. Pass your own to make
   *   timestamps and anything derived from them exactly reproducible in tests.
   * @param {(nodes: Node[], pool: Pool) => any} [options.onEvict]  default eviction hook,
   *   inherited by every pool unless that pool overrides it.
   * @param {object} [options.tagger]  default tagger, inherited by every pool
   * @param {object} [options.engine]  default search engine. A factory function is called once
   *   per pool, since an engine holds one pool's index and cannot be shared between them.
   */
  constructor({ defaultPool = "main", now = Date.now, onEvict = null, tagger = null, engine = null } = {}) {
    this.defaultPoolName = defaultPool;
    this.now = now;
    this.onEvict = onEvict;
    this.tagger = tagger;
    this.engine = engine;

    /** @type {Map<string, Pool>} */
    this._pools = new Map();

    this.pool(defaultPool); // exists from the start so the shorthand always has a target
  }

  /**
   * Get a pool, creating it if this is the first mention of that name.
   * @param {string} [name]  defaults to the default pool
   * @param {object} [options]  `now` and `onEvict` for a new pool; ignored if it already exists
   * @returns {Pool}
   */
  pool(name = this.defaultPoolName, options = {}) {
    const existing = this._pools.get(name);
    if (existing) return existing;

    const inherited = typeof this.engine === "function" ? this.engine() : this.engine;

    const pool = new Pool(name, {
      now: options.now ?? this.now,
      onEvict: options.onEvict ?? this.onEvict,
      tagger: options.tagger ?? this.tagger,
      engine: options.engine ?? inherited
    });
    this._pools.set(name, pool);
    return pool;
  }

  /**
   * Names of every pool that exists.
   * @returns {string[]}
   */
  pools() {
    return Array.from(this._pools.keys());
  }

  /**
   * @param {string} name
   * @returns {boolean}
   */
  hasPool(name) {
    return this._pools.has(name);
  }

  /**
   * Drop a pool and everything in it, without calling any eviction hook. The default pool
   * cannot be dropped, so clear it instead.
   * @param {string} name
   * @returns {boolean} whether a pool was there to drop
   */
  dropPool(name) {
    if (name === this.defaultPoolName) {
      throw new Error(`[liminal] the default pool "${name}" cannot be dropped, use clear() instead`);
    }
    return this._pools.delete(name);
  }

  /**
   * Find a node by id, wherever it lives. Ids are unique across every pool, which is what lets
   * a graph edge in one pool point at a node in another.
   * @param {string} id
   * @returns {Node|undefined}
   */
  get(id) {
    for (const pool of this._pools.values()) {
      const node = pool.get(id);
      if (node) return node;
    }
    return undefined;
  }

  /**
   * @param {string} id
   * @returns {boolean}
   */
  has(id) {
    return this.get(id) !== undefined;
  }

  /**
   * Total nodes across every pool.
   * @returns {number}
   */
  get size() {
    let total = 0;
    for (const pool of this._pools.values()) total += pool.size;
    return total;
  }

  /**
   * Add a node to the default pool.
   * @param {object} input  see `Pool.create`
   * @returns {Promise<Node>}
   */
  create(input) {
    return this.pool().create(input);
  }

  /**
   * Add several nodes to the default pool.
   * @param {object[]} inputs
   * @returns {Promise<Node[]>}
   */
  createMany(inputs) {
    return this.pool().createMany(inputs);
  }

  /**
   * Patch a node in the default pool.
   * @param {string} id
   * @param {object} patch
   * @returns {Promise<Node>}
   */
  update(id, patch) {
    return this.pool().update(id, patch);
  }

  /**
   * Every node in the default pool, oldest first.
   * @returns {Node[]}
   */
  list() {
    return this.pool().list();
  }

  /**
   * Search the default pool.
   * @param {string} query
   * @param {object} [options]
   * @returns {Promise<Node[]>}
   */
  search(query, options) {
    return this.pool().search(query, options);
  }

  /**
   * Search the default pool, keeping scores.
   * @param {string} query
   * @param {object} [options]
   * @returns {Promise<{node: Node, score: number}[]>}
   */
  rank(query, options) {
    return this.pool().rank(query, options);
  }

  /**
   * A plain snapshot of every pool. Safe to `JSON.stringify`.
   * @returns {{defaultPool: string, pools: {name: string, nodes: Node[]}[]}}
   */
  toJSON() {
    return {
      defaultPool: this.defaultPoolName,
      pools: Array.from(this._pools.values(), pool => pool.toJSON())
    };
  }

  /**
   * Load a snapshot, replacing every pool. Ids and timestamps come back exactly as they were.
   * @param {{defaultPool?: string, pools?: {name: string, nodes: Node[]}[]}} snapshot
   * @returns {LiminalMemory}
   */
  load(snapshot) {
    this._pools.clear();
    this.defaultPoolName = snapshot?.defaultPool ?? this.defaultPoolName;

    for (const poolSnapshot of snapshot?.pools ?? []) {
      this.pool(poolSnapshot.name).load(poolSnapshot);
    }

    this.pool(this.defaultPoolName); // recreate it if the snapshot had no pools at all
    return this;
  }

  /**
   * Empty every pool without calling any eviction hook.
   */
  clear() {
    for (const pool of this._pools.values()) pool.clear();
  }
}

export { Pool } from "./pool.js";
export { createNode, patchNode } from "./node.js";
export { uuid, generateId } from "./id.js";
export { BM25 } from "./search/bm25.js";
export { stem } from "./search/stem.js";
export { keywordTagger, extractKeywords, flattenToText, STOPWORDS } from "./tag/keywords.js";
export { BM25_DEFAULTS, KEYWORD_DEFAULTS };

/**
 * Every tunable value in one place to read, without one module everything has to import from.
 * Each still lives with the code that uses it, so overriding one means importing just that one.
 */
export const defaults = {
  bm25: BM25_DEFAULTS,
  keywords: KEYWORD_DEFAULTS
};

export default LiminalMemory;
