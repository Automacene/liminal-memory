/**
 * A pool, meaning one named collection of nodes and the lifecycle around it.
 *
 * Pools exist so different kinds of node don't share a search index. That isn't tidiness:
 * relevance scoring depends on corpus-wide statistics, so mixing hundred-word conversation
 * turns with eight-word tool descriptions distorts both. Separate pools mean separate
 * statistics, which makes ranking inside each one better and more predictable.
 *
 * Ids are unique across every pool, not just within one, so a graph edge can point anywhere.
 */
import { generateId } from "./id.js";
import { createNode, patchNode } from "./node.js";
import { keywordTagger } from "./tag/keywords.js";
import { BM25 } from "./search/bm25.js";

/**
 * Pulled in explicitly rather than relied on as a global: the browser lib already has a `Node`,
 * and without this import every reference below would silently resolve to that one instead.
 * @typedef {import("./node.js").Node} Node
 */

/**
 * Why some methods are async and others aren't: anything that can call one of your hooks
 * returns a promise, because JavaScript cannot wait on a promise from inside a synchronous
 * function. Once a tagger might be async, everything above it has to be. Pure reads that
 * never call a hook stay synchronous.
 *
 * `create`, `update`, and `evict` are already async even where they don't yet await anything,
 * so wiring the tagger in later doesn't change the signature under anyone.
 */
export class Pool {
  /**
   * @param {string} name
   * @param {object} [options]
   * @param {() => number} [options.now]  clock, defaults to `Date.now`. Pass your own to make
   *   timestamps and anything derived from them exactly reproducible in tests.
   * @param {(nodes: Node[], pool: Pool) => any} [options.onEvict]  called with the nodes
   *   leaving the pool, before they are dropped. Persist them here if you want them back.
   * @param {{forNode: Function, forQuery: Function}} [options.tagger]  turns content into the
   *   terms the engine indexes, and a query into the terms it looks up. Defaults to keywords.
   * @param {{add: Function, remove: Function, search: Function, clear: Function}} [options.engine]
   *   ranks ids against terms. Defaults to BM25. Swap both together, since an engine only
   *   understands the terms its paired tagger produces.
   */
  constructor(name, { now = Date.now, onEvict = null, tagger = null, engine = null } = {}) {
    if (!name || typeof name !== "string") {
      throw new Error("[liminal] a pool needs a name");
    }

    this.name = name;
    this.now = now;
    this.onEvict = onEvict;
    this.tagger = tagger ?? keywordTagger();
    this.engine = engine ?? new BM25();

    /** @type {Map<string, Node>} insertion-ordered, which is what makes "oldest" meaningful */
    this._nodes = new Map();

    /**
     * Nodes that exist but are not in the index yet, drained on the next search. Loading a
     * snapshot puts everything here rather than re-tagging the whole pool up front, so the
     * cost lands on the first query instead of on startup.
     * @type {Set<string>}
     */
    this._pending = new Set();
  }

  /**
   * Add a node. Returns the stored node, including the id it was given.
   *
   * Supply `id` to name a node yourself, which helps when something outside this library
   * already has a stable name for it. A supplied id replaces the generated one completely, so it
   * carries no pool prefix. Reusing an existing id throws rather than overwriting, because a
   * silent overwrite loses a node and you find out about it much later.
   *
   * @param {object} input
   * @param {*} input.content  required; any type, including null
   * @param {string} [input.id]
   * @param {object} [input.tags]
   * @param {object} [input.graph]
   * @param {object} [input.metadata]
   * @returns {Promise<Node>}
   */
  async create({ id, content, tags, graph, metadata } = {}) {
    const nodeId = id ?? generateId(this.name);

    if (this._nodes.has(nodeId)) {
      throw new Error(`[liminal] node "${nodeId}" already exists in pool "${this.name}"`);
    }

    const node = createNode({
      id: nodeId,
      pool: this.name,
      content,
      tags,
      graph,
      metadata,
      at: this.now()
    });

    this._nodes.set(node.id, node);
    await this._index(node);
    return node;
  }

  /**
   * Add several nodes in order. Any rejected id aborts the whole call, so a batch either
   * lands completely or not at all.
   * @param {object[]} inputs
   * @returns {Promise<Node[]>}
   */
  async createMany(inputs = []) {
    for (const input of inputs) {
      const id = input?.id;
      if (id != null && this._nodes.has(id)) {
        throw new Error(`[liminal] node "${id}" already exists in pool "${this.name}"`);
      }
    }

    const created = [];
    for (const input of inputs) created.push(await this.create(input));
    return created;
  }

  /**
   * Replace parts of a node. Named buckets are swapped wholesale, `metadata` merges, and
   * `id`/`pool` are ignored if present. See `patchNode`.
   * @param {string} id
   * @param {{content?: *, tags?: object, graph?: object, metadata?: object}} patch
   * @returns {Promise<Node>}
   */
  async update(id, patch = {}) {
    const existing = this._nodes.get(id);
    if (!existing) {
      throw new Error(`[liminal] no node "${id}" in pool "${this.name}"`);
    }

    const next = patchNode(existing, patch, this.now());

    // New content with no tags to go with it means the old tags describe text that is gone,
    // so they get dropped and rebuilt. Tags handed in explicitly are always left alone.
    if ("content" in patch && !("tags" in patch)) next.tags = {};

    this._nodes.set(id, next);
    await this._index(next);
    return next;
  }

  /**
   * Hand nodes to `onEvict` and then drop them. This is the way out of the pool for anything
   * you want to keep, so write it to disk, a database, or wherever else. Compare `remove`,
   * which simply forgets.
   *
   * The selector is either a list of ids or a predicate run over every node.
   *
   * @param {string[] | ((node: Node) => boolean)} selector
   * @returns {Promise<Node[]>} the nodes that left, in pool order
   */
  async evict(selector) {
    const going = typeof selector === "function"
      ? this.list().filter(selector)
      : (selector ?? []).map(id => this._nodes.get(id)).filter(Boolean);

    if (going.length === 0) return [];

    if (this.onEvict) await this.onEvict(going, this);

    for (const node of going) {
      this._nodes.delete(node.id);
      this._forget(node.id);
    }
    return going;
  }

  /**
   * Evict the `count` least recently added nodes.
   * @param {number} count
   * @returns {Promise<Node[]>}
   */
  async evictOldest(count) {
    if (!(count > 0)) return [];
    return this.evict(this.ids().slice(0, count));
  }

  /**
   * The nodes matching a query, best first.
   *
   * The same pool and the same query always give the same nodes in the same order. Nothing
   * here consults the clock, and the engine breaks score ties on id rather than leaving them
   * to insertion order.
   *
   * Nodes with null content are never returned, because there is nothing to match against.
   * Reach them by walking the graph instead.
   *
   * @param {string} query
   * @param {object} [options]
   * @param {number} [options.limit]
   * @returns {Promise<Node[]>}
   */
  async search(query, options = {}) {
    const ranked = await this.rank(query, options);
    return ranked.map(hit => hit.node);
  }

  /**
   * The same as `search`, keeping the score alongside each node.
   *
   * Worth knowing before comparing scores across pools: they are not comparable. A score is
   * relative to the term statistics of the pool that produced it, so merging two pools' results
   * means normalizing each side first, usually by dividing by that pool's top score.
   *
   * @param {string} query
   * @param {object} [options]
   * @param {number} [options.limit]
   * @returns {Promise<{node: Node, score: number}[]>}
   */
  async rank(query, { limit = 10 } = {}) {
    await this._drainPending();

    const terms = await this.tagger.forQuery(query);
    const hits = this.engine.search(terms, limit);

    const ranked = [];
    for (const hit of hits) {
      const node = this._nodes.get(hit.id);
      if (node) ranked.push({ node, score: hit.score });
    }

    return ranked;
  }

  /**
   * @param {string} id
   * @returns {Node|undefined}
   */
  get(id) {
    return this._nodes.get(id);
  }

  /**
   * @param {string} id
   * @returns {boolean}
   */
  has(id) {
    return this._nodes.has(id);
  }

  /**
   * Every node, oldest first.
   * @returns {Node[]}
   */
  list() {
    return Array.from(this._nodes.values());
  }

  /**
   * Every id, oldest first.
   * @returns {string[]}
   */
  ids() {
    return Array.from(this._nodes.keys());
  }

  /**
   * @returns {number}
   */
  get size() {
    return this._nodes.size;
  }

  /**
   * Forget a node without telling anyone. Use `evict` when the node should be kept somewhere.
   * @param {string} id
   * @returns {boolean} whether a node was there to remove
   */
  remove(id) {
    this._forget(id);
    return this._nodes.delete(id);
  }

  /**
   * Empty the pool without calling `onEvict`.
   */
  clear() {
    this._nodes.clear();
    this._pending.clear();
    this.engine.clear();
  }

  /**
   * A plain snapshot of the pool. Safe to `JSON.stringify`.
   * @returns {{name: string, nodes: Node[]}}
   */
  toJSON() {
    return { name: this.name, nodes: this.list() };
  }

  /**
   * Load a snapshot, replacing whatever is in the pool. Node ids and timestamps come back
   * exactly as they were.
   * @param {{nodes: Node[]}} snapshot
   * @returns {Pool}
   */
  load(snapshot) {
    this.clear();

    for (const node of snapshot?.nodes ?? []) {
      this._nodes.set(node.id, { ...node, pool: this.name });
      this._pending.add(node.id);
    }

    return this;
  }

  /**
   * Tag a node if it needs it, then put it in the index.
   *
   * A node arrives untagged in the usual case and gets tagged here. One that already carries
   * tags is left alone, whether they came from the caller or from a previous run, so hand-written
   * tags are never silently overwritten.
   *
   * @param {Node} node
   * @returns {Promise<void>}
   */
  async _index(node) {
    this._pending.delete(node.id);

    if (node.content == null) {
      this.engine.remove(node.id);
      return;
    }

    if (Object.keys(node.tags).length === 0) {
      node.tags = await this.tagger.forNode(node);
    }

    this.engine.add(node.id, await this.tagger.termsOf(node.tags));
  }

  /**
   * Bring every node waiting to be indexed into the index. Called before a query so a pool
   * loaded from a snapshot is searchable without anyone having to remember to rebuild it.
   * @returns {Promise<void>}
   */
  async _drainPending() {
    if (this._pending.size === 0) return;

    for (const id of Array.from(this._pending)) {
      const node = this._nodes.get(id);
      if (node) await this._index(node);
      else this._pending.delete(id);
    }
  }

  /**
   * Drop a node from the index and from the waiting list.
   * @param {string} id
   */
  _forget(id) {
    this._pending.delete(id);
    this.engine.remove(id);
  }
}
