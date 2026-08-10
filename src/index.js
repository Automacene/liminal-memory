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
import { GRAPH_DEFAULTS } from "./graph/decay.js";

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
   * @param {object} [options.graph]  default graph algorithm, inherited by every pool
   */
  constructor({
    defaultPool = "main", now = Date.now, onEvict = null,
    tagger = null, engine = null, graph = null
  } = {}) {
    this.defaultPoolName = defaultPool;
    this.now = now;
    this.onEvict = onEvict;
    this.tagger = tagger;
    this.engine = engine;
    this.graph = graph;

    /** @type {Map<string, Pool>} */
    this._pools = new Map();

    this.pool(defaultPool); // exists from the start so the shorthand always has a target
  }

  /**
   * Get a pool, LAZILY CREATING it if this is the first mention of that name. There is no
   * separate step for declaring a pool, so a typo in a pool name gives you a new empty pool
   * rather than an error.
   *
   * Passing options for a pool that already exists reconfigures it rather than being ignored,
   * so this doubles as the way to attach a hook after the fact. The one exception is `engine`,
   * which holds the pool's index and cannot be swapped without throwing the index away.
   *
   * @param {string} [name]  defaults to the default pool
   * @param {object} [options]  `now`, `onEvict`, `tagger`, `graph`, and (on creation) `engine`
   * @returns {Pool}
   */
  pool(name = this.defaultPoolName, options = {}) {
    const existing = this._pools.get(name);
    if (existing) {
      // Configure rather than ignore. `pool("active", { onEvict })` reads like it sets the
      // hook, so it sets the hook, whether or not this is the first mention of the name.
      // Silently dropping the options was a real bug during development and gave no signal at
      // all: eviction simply did nothing.
      if (options.onEvict !== undefined) existing.onEvict = options.onEvict;
      if (options.tagger !== undefined) existing.tagger = options.tagger;
      if (options.graph !== undefined) existing.graph = options.graph;
      if (options.now !== undefined) existing.now = options.now;
      return existing;
    }

    const inherited = typeof this.engine === "function" ? this.engine() : this.engine;

    const pool = new Pool(name, {
      now: options.now ?? this.now,
      onEvict: options.onEvict ?? this.onEvict,
      tagger: options.tagger ?? this.tagger,
      engine: options.engine ?? inherited,
      graph: options.graph ?? this.graph
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
   * Search the default pool. A `from` id is resolved across every pool, so the node asking the
   * question does not have to live in the pool being searched.
   * @param {string} query
   * @param {object} [options]
   * @returns {Promise<Node[]>}
   */
  search(query, options) {
    return this.pool().search(query, this._withAsker(options));
  }

  /**
   * Search the default pool, keeping scores.
   * @param {string} query
   * @param {object} [options]
   * @returns {Promise<{node: Node, score: number, raw: number}[]>} `score` in 0 to 1, `raw`
   *   the uncalibrated BM25 figure
   */
  rank(query, options) {
    return this.pool().rank(query, this._withAsker(options));
  }

  /**
   * Connect two nodes in any pools. Leave `observedAt` off for an edge that never decays.
   *
   * This is the cross-pool version of `Pool.link`: it looks both ends up by id anywhere, which
   * is the point of ids being unique everywhere rather than only inside a pool.
   *
   * @param {string|Node} from
   * @param {string|Node} to
   * @param {number} [observedAt]
   * @returns {boolean} whether both ends were found
   */
  link(from, to, observedAt) {
    const a = typeof from === "string" ? this.get(from) : from;
    const b = typeof to === "string" ? this.get(to) : to;
    if (!a || !b) return false;

    this.pool(a.pool).graph.link(a, b, observedAt);
    return true;
  }

  /**
   * Everything a node is connected to, after dropping anything that has decayed.
   * @param {string|Node} node
   * @returns {{id: string, observedAt: number|undefined, direction: "to"|"from"}[]}
   */
  neighbors(node) {
    const found = typeof node === "string" ? this.get(node) : node;
    if (!found) return [];

    return this.pool(found.pool).neighbors(found);
  }

  /**
   * Turn a `from` id into the actual node, looking in every pool rather than just the one being
   * searched.
   * @param {object} [options]
   * @returns {object}
   */
  _withAsker(options = {}) {
    if (typeof options.from !== "string") return options;
    return { ...options, from: this.get(options.from) };
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
export { decayGraph } from "./graph/decay.js";
export { BM25_DEFAULTS, KEYWORD_DEFAULTS, GRAPH_DEFAULTS };

/**
 * Every tunable value in one place to read, without one module everything has to import from.
 * Each still lives with the code that uses it, so overriding one means importing just that one.
 */
export const defaults = {
  bm25: BM25_DEFAULTS,
  keywords: KEYWORD_DEFAULTS,
  graph: GRAPH_DEFAULTS
};

export default LiminalMemory;
