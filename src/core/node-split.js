/**
 * Node splitting — when a node accumulates too many children it splits them into two
 * keyword-grouped category nodes and demotes itself to point at just those two, forming a
 * hierarchy through use. Pure algorithm over a Chain passed in (uses its graph primitives);
 * it owns no state, so the clustering policy stays out of the Chain data structure.
 */

// Soft target of 3 children; a node splits the moment it reaches double that (6).
export const SOFT_CAP = 3;
export const SPLIT_THRESHOLD = SOFT_CAP * 2;

// Max keywords a category node exposes to the index. The raw union of member keywords would make
// the category a match-all "hub" that dominates recall and keeps re-overflowing; the cap prevents it.
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
    // Two category nodes, labeled by their group's top shared keyword (deterministic, no LLM).
    // Each footprint is scored differentially against its sibling and weighted by global IDF so
    // corpus-wide terms don't dominate. The cap is what kills the match-all magnet; IDF refines.
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

    // If a custom namer is plugged in, queue these categories for off-hot-path renaming.
    // Their instant keyword names are already set, so the split stays fast.
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
 * Distinctive keyword footprint for a category, instead of the raw member union (which would make
 * a match-all recall hub). Score each term by frequency in `group`, weighted by its purity vs the
 * `sibling` and by `globalWeight` (global rarity), drop the rare tail, keep the top `cap`.
 * Deterministic, runs once at split time.
 *   score = inCount · (inCount / (inCount + outCount)) · globalWeight(term)
 * @param {object[]} group - the category's own members
 * @param {object[]} sibling - the other half of the split (local contrast set)
 * @param {number} [cap=KEYWORD_FOOTPRINT_CAP]
 * @param {(term: string) => number} [globalWeight] - global rarity weight (IDF); defaults to 1
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
 * Smoothed-IDF function over the chain's content nodes (category/compaction excluded so the
 * splitter's own output doesn't feed back into the score). Same formula as the BM25 engine
 * (src/search/bm25.js). Computed once per split — off the recall hot path — reading only the Chain.
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
 * Create a category node and register it on the chain. Label = top shared keyword (display only);
 * `keywords` = the distinctive footprint from the caller (see `differentialKeywords`), which is
 * what the system actually matches and splits on.
 * @param {import('./chain.js').Chain} chain
 * @param {object[]} members
 * @param {string[]} keywords - the category's distinctive keyword footprint
 * @returns {object} the new category node
 */
function createCategoryNode(chain, members, keywords) {
  const label = topSharedKeyword(members);
  // Fall back to the member union if the footprint came back empty, so the node stays recall-able.
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
