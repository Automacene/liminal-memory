/**
 * Conservative stemmer — collapses common inflected forms to a shared stem so related nodes match
 * across different endings ("index"/"indexing"/"indexed"). Deliberately gentle (only -s/-es/-ies,
 * -ing, -ed with length guards, never short words): in a memory graph a false match silently
 * pollutes recall, so we accept missing a few variants over an aggressive stemmer's wrong merges
 * ("universe"/"university"). Pure, deterministic, idempotent.
 *
 * MUST be applied identically everywhere terms are produced (node keywords, BM25 index + query,
 * retrieval tokenizing) — stemming one side but not the other silently breaks matching.
 * @param {string} term
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
