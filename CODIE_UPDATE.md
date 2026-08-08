# Codie — Node Schema & Graph Implementation

This is what we implemented from the idea you described. Josh was trying to explain your node schema concept and the directional graph stuff. Here's what landed.

---

## Node Schema (implemented)

Every node in the system now has:

```javascript
{
  content: "...",                    // The data. String for now, but structurally could be anything.
  keywords: ["term", "term", ...],  // Extracted from content at creation time. Stopwords stripped.
  graph: {
    edges_to: [nodeId, nodeId, ...],   // Nodes THIS node referenced/discovered
    edges_from: [nodeId, nodeId, ...]  // Nodes that referenced/discovered THIS node
  }
}
```

### Keywords
- Auto-generated when a node is created (no manual tagging)
- Content gets flattened (handles strings, objects, arrays — anything nested), tokenized, stopwords removed, deduped
- Only terms 3+ chars survive
- This is meant to be what BM25 searches against (right now BM25 still indexes full content — switching it to keywords-only is the next step)

### Graph
- Directional. `edges_to` ≠ `edges_from`. Direction = flow of discovery.
- "Node A has `edges_to: [B]`" means A was the context that caused B to be found
- "Node B has `edges_from: [A]`" means B was discovered because of A
- Edges form through use, not at ingest time. New docs have empty graphs. They fill in naturally through conversation.

---

## How Edges Form (through natural use)

The idea: don't pre-link anything. Let the graph build itself from actual retrieval patterns.

### Sovereign pass (broad):
1. User asks something
2. BM25 finds relevant nodes
3. Current turn node gets `edges_to` pointing at those found nodes
4. Those found nodes get `edges_from` pointing back at the turn

### Ephemeral pass (enriched):
1. Ephemeral has BOTH the user's question AND the sovereign's response
2. It extracts a richer query from the combined text
3. Runs BM25 again with more signal — finds nodes the first pass missed
4. Links those to the current turn (same direction: turn → found)
5. Also links co-retrieved nodes to EACH OTHER (if A and B were both found in the same search, they're probably related — edge between them)

### Over time:
- Nodes that keep getting retrieved together become densely connected
- Clusters emerge without anyone defining them
- The graph is the system's learned understanding of what relates to what

---

## N-Hop Traversal at Query Time

When BM25 returns initial results, the system follows edges to expand:

1. BM25 finds nodes A, B, C
2. System checks A's `edges_to` and `edges_from` — finds D, E
3. System checks B's edges — finds F
4. Result set: A, B, C, D, E, F (expanded from 3 to 6)

Configurable: `linkDistance: N` controls how many hops. Currently set to 2.

### What we saw it doing:
```
Query 1: BM25 found 3 → created 6 edges
Query 2: BM25 found 6 → traversal expanded to 11 (+5 from graph)
Query 3: BM25 found 6 → traversal expanded to 7 (+1 from graph)
```

Three conversations in and the graph is already surfacing nodes that keyword matching alone wouldn't find.

---

## What's NOT done yet

- **BM25 should search keywords array, not full content.** The schema is ready. The BM25 integration still indexes raw content text. Switching it to match keywords-against-keywords is the next step. That's the core of what you were describing — both sides reduced to their keyword fingerprints, then matched.
- **Content as flexible object.** Right now content is always a string. Your schema shows it as `{ user: "...", agent: "..." }` or `{ data: { nested: "..." } }`. The keyword extractor already handles arbitrary structures (flattens anything), but the content field itself is still stored as a string.
- **Self-organization / clustering.** The edges accumulate but nothing yet reads the graph topology to identify clusters or categories. That's the "inverted neural network" part — emergent grouping from connection density.

---

## Files Changed

- `src/core/node.js` — Added `keywords`, `graph` fields + `extractKeywords()` static method
- `src/core/chain.js` — `append()` and `appendTurn()` auto-extract keywords + init empty graph. `link(fromId, toId)` creates directional edges.
- `src/config.js` — Added `linkDistance: 1` (currently overridden to 2 in demo)
- `demo/ui/js/internal/app.js` — Recall expansion via N-hop graph traversal. Edges created on every retrieval.
- `demo/ui/js/internal/sovereign-loop.js` — Enriched recall after ephemeral critique. Links co-retrieved nodes to each other.
