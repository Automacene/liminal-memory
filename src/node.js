/**
 * The node specification.
 *
 * A node is a plain object with four buckets and two identity fields. Three of the buckets
 * belong to whoever is using the library. Put a conversation turn, a document chunk, a tool
 * definition, keywords, embeddings, an ontology, whatever the program needs. Only `metadata`
 * has fields this library writes, and even there anything else you add is left alone.
 *
 * Nodes are data, not class instances. They serialize with `JSON.stringify` and come back
 * whole, and nothing here depends on a prototype being present.
 *
 * @typedef {object} Node
 * @property {string} id        globally unique across every pool
 * @property {string} pool      name of the pool holding this node
 * @property {*} content        yours: a string, `{user, assistant}`, a chunk, anything
 * @property {object} tags      yours: whatever your tagger produces
 * @property {object} graph     yours: edges, in the default form `{to: [], from: []}`
 * @property {NodeMetadata} metadata  `createdAt` and `updatedAt` are ours, the rest is yours
 *
 * @typedef {object} NodeMetadata
 * @property {number} createdAt  epoch ms, from the pool's clock
 * @property {number} updatedAt  epoch ms, from the pool's clock
 */

/**
 * Build a node. Called by the pool, which supplies the id, pool name, and timestamp, so you
 * normally reach for `pool.create()` rather than this.
 *
 * `content` is the only required part, and it can be any type including `null`. The three
 * open buckets default to empty so callers never have to guard before reading them. `graph`
 * defaults to the edge lists the built-in graph algorithm uses, and a custom algorithm is
 * free to replace that object entirely with its own layout.
 *
 * @param {object} params
 * @param {string} params.id
 * @param {string} params.pool
 * @param {*} params.content
 * @param {object} [params.tags]
 * @param {object} [params.graph]
 * @param {object} [params.metadata]  merged over `createdAt`/`updatedAt`
 * @param {number} params.at  epoch ms for both timestamps
 * @returns {Node}
 */
export function createNode({ id, pool, content, tags, graph, metadata, at }) {
  if (content === undefined) {
    throw new Error("[liminal] content is required (pass null if the node genuinely has none)");
  }

  return {
    id,
    pool,
    content,
    tags: tags ?? {},
    graph: graph ?? { to: [], from: [] },
    metadata: { createdAt: at, updatedAt: at, ...metadata }
  };
}

/**
 * Apply a patch to a node, returning a new node and leaving the original untouched.
 *
 * Buckets you name are replaced wholesale. Passing `tags` swaps the whole tag object rather
 * than merging keys into it, because a tagger's output is one unit and half-replacing it
 * would leave stale terms behind. `metadata` is the exception and does merge, so `createdAt`
 * and any fields you have added survive an update that doesn't mention them.
 *
 * `id` and `pool` are never patchable, because a node's identity is fixed for its lifetime.
 *
 * @param {Node} node
 * @param {{content?: *, tags?: object, graph?: object, metadata?: object}} patch
 * @param {number} at  epoch ms written to `updatedAt`
 * @returns {Node}
 */
export function patchNode(node, patch, at) {
  const next = {
    ...node,
    metadata: { ...node.metadata, ...patch.metadata, updatedAt: at }
  };

  if ("content" in patch) next.content = patch.content;
  if ("tags" in patch) next.tags = patch.tags ?? {};
  if ("graph" in patch) next.graph = patch.graph ?? { to: [], from: [] };

  return next;
}
