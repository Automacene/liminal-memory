/**
 * Node splitting — the "blacksky/darkmind" self-organizing rule (ROADMAP Phase 3).
 *
 * When a node accumulates too many children, it splits them into two keyword-grouped
 * category nodes and demotes itself to point at just those two — the bottom-up neural
 * network forming its own hierarchy through use. Per the split diagram: a hub's leaves
 * (its `edges_to` children) split into two similarity groups; the hub stays the root.
 *
 * This module is pure algorithm + orchestration. It owns NO state — it operates on a
 * Chain passed in, using the Chain's own graph primitives (`get`, `insert`, `_rawLink`,
 * `_unlink`). Chain is the data structure; this is the policy that reshapes it. Keeping
 * them separate is deliberate (see agents/modular-design.md) — Chain shouldn't grow a
 * clustering algorithm inside it.
 */

// Soft target of 3 children per node; the moment a node reaches double that (6), it splits.
export const SOFT_CAP = 3;
export const SPLIT_THRESHOLD = SOFT_CAP * 2;

/**
 * Check the node that just gained a child and split it if it's overflowing. Called from
 * Chain.link() after an edge is added. No-op while a split is already in flight (the edge
 * surgery a split performs must not recursively re-trigger); genuine recursion — a category
 * that later fills up — happens on future link() calls.
 * @param {import('./chain.js').Chain} chain
 * @param {object} hub - the node that just gained an outgoing edge
 */
export function maybeSplit(chain, hub) {
  if (chain._splitting) return;
  const childIds = (hub.graph && hub.graph.edges_to) || [];
  if (childIds.length < SPLIT_THRESHOLD) return;

  const members = childIds.map(id => chain.get(id)).filter(Boolean);
  if (members.length < SPLIT_THRESHOLD) return;

  const { groupA, groupB } = groupByKeywordOverlap(members);
  if (groupA.length === 0 || groupB.length === 0) return; // nothing sensible to split

  chain._splitting = true;
  try {
    // Two category nodes, each labeled by its group's top shared keyword — deterministic,
    // no LLM. The system matches/splits on keyword profiles, not labels, so a fast keyword
    // label is all a category needs; naming never blocks the retrieval hot path.
    const catA = createCategoryNode(chain, groupA);
    const catB = createCategoryNode(chain, groupB);

    // Parent demotion: detach the hub from its children, re-point it at the two categories.
    for (const m of members) chain._unlink(hub, m);
    chain._rawLink(hub, catA);
    chain._rawLink(hub, catB);
    // Each category takes its half of the original children as members.
    for (const m of groupA) chain._rawLink(catA, m);
    for (const m of groupB) chain._rawLink(catB, m);
  } finally {
    chain._splitting = false;
  }
}

/**
 * Partition members into two groups by keyword overlap. Seeds = the pair sharing the
 * FEWEST keywords (most dissimilar); each remaining member joins whichever seed it shares
 * more keywords with, ties broken toward the smaller group to stay balanced.
 * @param {object[]} members
 * @returns {{ groupA: object[], groupB: object[] }}
 */
export function groupByKeywordOverlap(members) {
  let seedA = members[0], seedB = members[1], minOverlap = Infinity;
  for (let i = 0; i < members.length; i++) {
    for (let j = i + 1; j < members.length; j++) {
      const o = keywordOverlap(members[i], members[j]);
      if (o < minOverlap) { minOverlap = o; seedA = members[i]; seedB = members[j]; }
    }
  }
  const groupA = [seedA], groupB = [seedB];
  for (const n of members) {
    if (n === seedA || n === seedB) continue;
    const oa = keywordOverlap(n, seedA);
    const ob = keywordOverlap(n, seedB);
    if (oa > ob) groupA.push(n);
    else if (ob > oa) groupB.push(n);
    else (groupA.length <= groupB.length ? groupA : groupB).push(n);
  }
  return { groupA, groupB };
}

/** Count of keywords two nodes share. */
export function keywordOverlap(a, b) {
  const ka = new Set(a.keywords || []);
  let count = 0;
  for (const k of (b.keywords || [])) if (ka.has(k)) count++;
  return count;
}

/** The most frequent keyword across a group's members — the deterministic category name. */
export function topSharedKeyword(members) {
  const freq = new Map();
  for (const m of members) {
    for (const k of (m.keywords || [])) freq.set(k, (freq.get(k) || 0) + 1);
  }
  let best = null, bestCount = 0;
  for (const [k, c] of freq) if (c > bestCount) { bestCount = c; best = k; }
  return best || "topic";
}

/**
 * Create a category node holding the given members and register it on the chain. Its label
 * is the deterministic top shared keyword (instant, no LLM) and its `keywords` are the union
 * of its members' keywords — that keyword profile is what the system actually matches and
 * splits on, so the label is only for display. No LLM naming: keeping the split path fast
 * and fully deterministic is the whole point (see agents/small-model-constraint.md).
 * @param {import('./chain.js').Chain} chain
 * @param {object[]} members
 * @returns {object} the new category node
 */
function createCategoryNode(chain, members) {
  const label = topSharedKeyword(members);
  const node = {
    id: chain.nextId,
    parentId: 0,
    role: "category",
    query: "",
    response: "",
    content: label,
    timestamp: Date.now(),
    tokenCount: Math.ceil((label.length || 1) / 4),
    pocketNotes: [],
    metadata: { isCategory: true, members: members.map(m => m.id) },
    keywords: Array.from(new Set(members.flatMap(m => m.keywords || []))),
    graph: { edges_to: [], edges_from: [] }
  };
  chain.insert(node); // assigns position by id order and bumps nextId
  return node;
}
