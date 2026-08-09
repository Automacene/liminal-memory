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

// A category node exposes at most this many keywords to the retrieval index. A raw union of
// its members' keywords turns the category into a match-all "hub" that dominates recall (the
// hubness problem) and keeps re-overflowing — so we cap the footprint to a distinctive few.
export const KEYWORD_FOOTPRINT_CAP = 12;

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
    // Each category's keyword footprint is scored DIFFERENTIALLY against its sibling group and
    // weighted by global rarity (IDF over the whole chain), so codebase-wide terms that only
    // *look* distinctive across this one binary partition don't dominate the profile. The cap
    // is the real fix (it kills the match-all "magnet"); IDF is a mild, standard refinement.
    // We deliberately do NOT chase further "filler" removal — the Ephemeral loop makes the
    // final selection from the candidate set + Sovereign + query, so signpost precision past
    // this point has diminishing value (see agents note / memory: ephemeral-final-selection).
    const idfFn = corpusIdf(chain);
    const catA = createCategoryNode(chain, groupA, differentialKeywords(groupA, groupB, KEYWORD_FOOTPRINT_CAP, idfFn));
    const catB = createCategoryNode(chain, groupB, differentialKeywords(groupB, groupA, KEYWORD_FOOTPRINT_CAP, idfFn));

    // Parent demotion: detach the hub from its children, re-point it at the two categories.
    for (const m of members) chain._unlink(hub, m);
    chain._rawLink(hub, catA);
    chain._rawLink(hub, catB);
    // Each category takes its half of the original children as members.
    for (const m of groupA) chain._rawLink(catA, m);
    for (const m of groupB) chain._rawLink(catB, m);

    // Off-hot-path naming: if a custom namer is plugged in, just record these two new category
    // nodes for later renaming — a cheap push, no naming work here. Their instant keyword names
    // are already set above, so the split stays fast and fully deterministic regardless.
    if (chain.recordCategoryNaming) {
      chain.pendingCategoryNaming.push(
        { categoryId: catA.id, memberIds: groupA.map(m => m.id) },
        { categoryId: catB.id, memberIds: groupB.map(m => m.id) }
      );
    }
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

/** How many members of a group each keyword appears in — the raw document frequency. */
export function termFreq(members) {
  const freq = new Map();
  for (const m of members) {
    for (const k of (m.keywords || [])) freq.set(k, (freq.get(k) || 0) + 1);
  }
  return freq;
}

/** The most frequent keyword across a group's members — the deterministic category name. */
export function topSharedKeyword(members) {
  let best = null, bestCount = 0;
  for (const [k, c] of termFreq(members)) if (c > bestCount) { bestCount = c; best = k; }
  return best || "topic";
}

/**
 * Differential keyword footprint for a category node. Rather than the raw union of member
 * keywords — which makes a match-all node that dominates recall (the "hubness" problem) and
 * keeps re-overflowing — score each candidate term by how distinctive it is to THIS group
 * versus its `sibling`, drop the rare tail, and keep the top few. This mirrors *differential
 * cluster labeling* from the IR literature: contrast term distributions across clusters, omit
 * rare terms. The result is a category that stays recall-able on its own theme without
 * swallowing unrelated queries. Deterministic and cheap (term counts over two small groups) —
 * no LLM, no hot-path cost; it runs once, at split time.
 *
 * Score = inCount · (inCount / (inCount + outCount)) · idf(term) — local frequency weighted by
 * its *purity* (the share of the term's mass belonging to this group vs the sibling) and by the
 * term's *global rarity*. Purity handles the local contrast; IDF handles the global one — a term
 * common across the whole graph (`llm`, `prompt`) has an IDF near zero, so however it happens to
 * fall across this one binary partition it can't dominate the footprint. Terms that are both
 * locally distinctive AND globally rare rise to the top.
 * @param {object[]} group - the category's own members
 * @param {object[]} sibling - the other half of the split, used as the local contrast set
 * @param {number} [cap=KEYWORD_FOOTPRINT_CAP]
 * @param {(term: string) => number} [globalWeight] - global specificity weight (e.g. IDF ×
 *   co-occurrence specificity); down-weights indiscriminate terms. Defaults to 1 (local-only).
 * @returns {string[]} distinctive keywords, most-distinctive first, at most `cap`
 */
export function differentialKeywords(group, sibling, cap = KEYWORD_FOOTPRINT_CAP, globalWeight = null) {
  const inFreq = termFreq(group);
  const outFreq = termFreq(sibling);
  const scored = [];
  for (const [term, inC] of inFreq) {
    const outC = outFreq.get(term) || 0;
    const global = globalWeight ? globalWeight(term) : 1;
    scored.push({ term, score: inC * (inC / (inC + outC)) * global, inC });
  }
  scored.sort((a, b) => b.score - a.score || b.inC - a.inC);

  // Prefer terms shared by ≥2 members (drop the long rare tail). Fall back to cluster-internal
  // top terms for small/loose groups so a category never goes keyword-dark.
  let kept = scored.filter(s => s.inC >= 2);
  if (kept.length < 3) kept = scored;
  return kept.slice(0, cap).map(s => s.term);
}

/**
 * Build a smoothed-IDF function over the chain's current corpus — the global rarity signal a
 * per-split sibling contrast can't see on its own. Document frequency counts how many real
 * content nodes contain each term; category and compaction nodes are excluded so df reflects
 * the actual corpus, not the hierarchy the splitter itself is building (which would feed its
 * own output back into the scoring). The formula matches the BM25 engine's IDF exactly
 * (src/search/bm25.js) so "rarity" means the same thing across retrieval and splitting.
 *
 * Computed once per split (splits are rare and fire at ingest/link time, never on the recall
 * hot path), so a full O(nodes) pass here is cheap and keeps the split path free of any
 * dependency on the search layer — it reads only the Chain it already operates on.
 * @param {import('./chain.js').Chain} chain
 * @returns {(term: string) => number}
 */
export function corpusIdf(chain) {
  const df = new Map();
  let n = 0;
  for (const node of chain.all()) {
    if (node.role === "category" || node.role === "compaction") continue;
    n++;
    for (const term of new Set(node.keywords || [])) df.set(term, (df.get(term) || 0) + 1);
  }
  return (term) => {
    const d = df.get(term) || 0;
    return Math.log(1 + (n - d + 0.5) / (d + 0.5));
  };
}

/**
 * Create a category node holding the given members and register it on the chain. Its label is
 * the deterministic top shared keyword (instant, no LLM) and its `keywords` are the distinctive
 * footprint computed by the caller (see `differentialKeywords`) — a bounded, distinctive profile
 * rather than the raw member union, so the category doesn't become a match-all recall hub. That
 * keyword profile is what the system matches and splits on; the label is only for display. No
 * LLM naming: keeping the split path fast and fully deterministic is the whole point (see
 * agents/small-model-constraint.md).
 * @param {import('./chain.js').Chain} chain
 * @param {object[]} members
 * @param {string[]} keywords - the category's distinctive keyword footprint
 * @returns {object} the new category node
 */
function createCategoryNode(chain, members, keywords) {
  const label = topSharedKeyword(members);
  // Guard: never let a category go keyword-dark. If the differential footprint came back empty
  // (a degenerate group), fall back to the member union so the node stays recall-able.
  const footprint = (keywords && keywords.length)
    ? keywords
    : Array.from(new Set(members.flatMap(m => m.keywords || [])));
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
    keywords: footprint,
    graph: { edges_to: [], edges_from: [] }
  };
  chain.insert(node); // assigns position by id order and bumps nextId
  return node;
}
