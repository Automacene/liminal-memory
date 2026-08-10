/**
 * The default graph: directed edges that optionally fade.
 *
 * This is deliberately naive. The graph is supported rather than central, and it never feeds
 * back into ranking, so a search returns the same nodes whether or not any edges exist. That
 * separation is what lets edges carry wall-clock times without putting determinism at risk.
 *
 * Decay is lazy, meaning nothing runs on a timer and expiry is applied only to nodes something
 * touches. See `sweep` for what that costs you.
 *
 * An edge is `{id, observedAt}`, where `observedAt` is the last time this connection was seen,
 * not when it was first made. Seeing it again moves the time forward. An edge with no
 * `observedAt` was never tied to a moment and so never decays, which is the default and suits
 * the fixed sequential links you would build across a document. Edges written during a search
 * always carry a time, so they fade unless recall keeps seeing them.
 *
 * Bring your own by implementing `link`, `sweep`, and `neighbors`.
 */

/**
 * Pulled in explicitly so `Node` does not resolve to the browser's `Node`.
 * @typedef {import("../node.js").Node} Node
 */

export const GRAPH_DEFAULTS = {
  /**
   * How long a timed edge survives without being seen again, in milliseconds. `Infinity` means
   * edges never expire, which is the default because most callers never look at the graph at
   * all. Note that zero is not the way to switch decay off: it would expire every timed edge
   * the instant it was written.
   */
  decayMs: Infinity
};

/**
 * Build the default graph algorithm.
 * @param {object} [options]
 * @param {number} [options.decayMs]
 * @returns {{link: Function, sweep: Function, neighbors: Function}}
 */
export function decayGraph(options = {}) {
  const { decayMs } = { ...GRAPH_DEFAULTS, ...options };

  return {
    /**
     * Record that `from` reached `to`. Linking a pair that is already linked moves `observedAt`
     * forward rather than adding a second edge, which is what makes repeated recall keep an
     * edge alive.
     *
     * Both nodes are mutated. This is synchronous on purpose: JavaScript runs a turn of the
     * event loop to completion, so as long as nothing awaits in here, two concurrent searches
     * cannot interleave partway through and leave one side of an edge written.
     *
     * @param {Node} from
     * @param {Node} to
     * @param {number} [observedAt]  omit for an edge that never decays
     */
    link(from, to, observedAt) {
      if (!from || !to || from.id === to.id) return;

      writeEdge(from.graph, "to", to.id, observedAt);
      writeEdge(to.graph, "from", from.id, observedAt);
    },

    /**
     * LAZY DECAY. Drop edges on this one node that have gone too long without being seen again.
     *
     * Nothing sweeps on a timer. Expiry is only ever applied to a node something touches, which
     * means a search, a `neighbors` read, or a manual sweep. Two consequences worth knowing:
     * a node nobody queries keeps its expired edges indefinitely, and because an edge is stored
     * on both ends, sweeping one end can leave the other end's half behind until that node is
     * touched too. Reading through `Pool.neighbors` never shows you either, but reading
     * `node.graph` directly can.
     *
     * @param {Node} node
     * @param {number} now
     * @returns {boolean} whether anything was dropped
     */
    sweep(node, now) {
      if (decayMs === Infinity || !node?.graph) return false;

      let changed = false;

      for (const direction of ["to", "from"]) {
        const edges = node.graph[direction];
        if (!Array.isArray(edges) || edges.length === 0) continue;

        const kept = edges.filter(
          edge => edge.observedAt == null || now - edge.observedAt <= decayMs
        );
        if (kept.length !== edges.length) {
          node.graph[direction] = kept;
          changed = true;
        }
      }

      return changed;
    },

    /**
     * Everything this node is connected to, in either direction.
     * @param {Node} node
     * @returns {{id: string, observedAt: number|undefined, direction: "to"|"from"}[]}
     */
    neighbors(node) {
      if (!node?.graph) return [];

      const found = [];
      for (const direction of ["to", "from"]) {
        for (const edge of node.graph[direction] ?? []) {
          found.push({ id: edge.id, observedAt: edge.observedAt, direction });
        }
      }

      return found;
    }
  };
}

/**
 * Add or refresh one side of an edge, creating the list on first use so the node
 * specification never has to know this layout exists.
 * @param {object} graph
 * @param {"to"|"from"} direction
 * @param {string} id
 * @param {number|undefined} observedAt
 */
function writeEdge(graph, direction, id, observedAt) {
  const edges = graph[direction] ?? (graph[direction] = []);
  const existing = edges.find(edge => edge.id === id);

  if (existing) {
    // A permanent edge stays permanent. Observing it again must not give it an expiry.
    if (observedAt == null) delete existing.observedAt;
    else if (existing.observedAt != null) existing.observedAt = observedAt;
    return;
  }

  edges.push(observedAt == null ? { id } : { id, observedAt });
}
