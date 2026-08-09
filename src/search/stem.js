/**
 * Conservative stemmer — collapses the common inflected forms of a word to a shared stem so
 * related nodes match even when they used different endings ("index" / "indexing" / "indexed").
 *
 * Deliberately GENTLE, not a full Porter/Snowball: it only trims the high-frequency inflections
 * (plural -s/-es/-ies, gerund -ing, past -ed) with length guards, and never touches short words.
 * The trade-off is intentional — in a memory graph a *false* match silently pollutes recall and
 * clustering, so we accept missing a few variants ("archive" vs "archived") to avoid merging
 * unrelated words the way an aggressive stemmer does ("universe"/"university" → "univers").
 *
 * Pure, deterministic, no dependencies — safe to call on the recall hot path. Idempotent:
 * stem(stem(w)) === stem(w), so it's harmless to apply more than once.
 *
 * MUST be applied identically everywhere terms are produced (node keyword extraction, BM25
 * indexing + query parsing, retrieval tokenizing) — stemming the index but not the query, or
 * vice-versa, silently breaks matching.
 *
 * @param {string} term - a single already-lowercased-or-not token
 * @returns {string} the stemmed term
 */
export function stem(term) {
  if (!term) return term;
  let w = term.toLowerCase();
  if (w.length <= 3) return w; // leave short tokens alone (idf, bm25, sql, api…)

  if (w.endsWith("ies") && w.length > 4) {
    w = w.slice(0, -3) + "y";               // categories → category, queries → query
  } else if (w.endsWith("ing") && w.length > 5) {
    w = collapseDouble(w.slice(0, -3));     // indexing → index, splitting → splitt → split
  } else if (w.endsWith("ed") && w.length > 4) {
    w = collapseDouble(w.slice(0, -2));     // indexed → index, mapped → map
  } else if (w.endsWith("es") && w.length > 4) {
    w = w.slice(0, -2);                     // matches → match, boxes → box, classes → class
  } else if (w.endsWith("s") && !w.endsWith("ss") && w.length > 3) {
    w = w.slice(0, -1);                     // splits → split; leaves "class"/"process" (ss) alone
  }
  return w;
}

/**
 * Collapse a trailing doubled consonant left behind by stripping -ing/-ed
 * (splitt → split, mapp → map). Vowels are left intact.
 * @param {string} w
 * @returns {string}
 */
function collapseDouble(w) {
  if (w.length > 2 &&
      w[w.length - 1] === w[w.length - 2] &&
      !"aeiou".includes(w[w.length - 1])) {
    return w.slice(0, -1);
  }
  return w;
}
