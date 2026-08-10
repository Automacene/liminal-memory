/**
 * The default tagger: plain keyword extraction.
 *
 * A tagger turns content into the terms a search engine matches on. This one lowercases,
 * strips punctuation, drops stopwords and very short tokens, stems what is left, and
 * deduplicates.
 *
 * It produces terms for two different things, and they must agree. Node terms are what gets
 * indexed, query terms are what gets looked up, and if the two pipelines diverge even
 * slightly then queries stop matching documents that plainly contain the word. That is easy
 * to do by accident, so both directions run through `extractKeywords` here rather than being
 * written twice.
 */
import { stem } from "../search/stem.js";

/**
 * Words carrying no retrieval signal. Kept deliberately short: an aggressive list throws away
 * terms that turn out to matter in a specific corpus, and a stopword you keep costs almost
 * nothing because it scores near zero anyway.
 *
 * Nothing here is shorter than `KEYWORD_DEFAULTS.minLength`, because the length filter already
 * drops those and listing them twice makes the set look like it does more than it does. Lowering
 * `minLength` below three therefore lets one and two letter words through, which is usually what
 * you want if you went to the trouble of lowering it.
 */
export const STOPWORDS = new Set([
  "the", "are", "was", "were", "been", "being", "have", "has", "had", "does",
  "did", "will", "would", "could", "should", "might", "shall", "can", "may",
  "must", "this", "that", "these", "those", "which", "what", "who", "whom",
  "where", "when", "why", "how", "not", "but", "and", "then", "else", "than",
  "too", "very", "just", "about", "all", "also", "any", "because", "before",
  "between", "both", "each", "few", "for", "from", "here", "into", "its",
  "more", "most", "once", "only", "other", "out", "over", "own", "same",
  "some", "such", "their", "them", "there", "through", "under", "until",
  "with", "you", "your", "our", "they", "she", "him", "her", "his"
]);

export const KEYWORD_DEFAULTS = {
  /** Tokens shorter than this are dropped. Three keeps "sql" and "api" while losing "an". */
  minLength: 3,
  stopwords: STOPWORDS,
  stem
};

/**
 * Flatten any content to a single string so it can be tokenized. Strings pass through, arrays
 * and objects are walked and their values joined, and null or undefined become empty.
 *
 * Only values are read, never keys, because a key like `user` or `assistant` is structure
 * rather than content and indexing it would make every conversation node match the word
 * "user".
 *
 * @param {*} content
 * @returns {string}
 */
export function flattenToText(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(flattenToText).join(" ");
  if (typeof content === "object") return Object.values(content).map(flattenToText).join(" ");
  return String(content);
}

/**
 * Text to a deduplicated list of stemmed terms.
 *
 * @param {string} text
 * @param {object} [options]
 * @param {number} [options.minLength]
 * @param {Set<string>} [options.stopwords]
 * @param {(term: string) => string} [options.stem]
 * @returns {string[]} unique terms, in first-seen order
 */
export function extractKeywords(text, options = {}) {
  const { minLength, stopwords, stem: stemFn } = { ...KEYWORD_DEFAULTS, ...options };

  if (!text) return [];

  const seen = new Set();
  const terms = [];

  for (const raw of text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/)) {
    if (raw.length < minLength) continue;
    if (stopwords.has(raw)) continue;

    const term = stemFn(raw);
    if (!term || seen.has(term)) continue;

    seen.add(term);
    terms.push(term);
  }

  return terms;
}

/**
 * Build the default tagger.
 *
 * A tagger is any object with three methods. `forNode` returns the whole `tags` bucket for a
 * node, so a custom tagger is free to return `{embedding: [...]}` or anything else.
 * `termsOf` reads a tags bucket back out as the terms the engine indexes, which is what lets
 * a caller write tags by hand and still have them searchable. `forQuery` turns a query string
 * into terms to look up.
 *
 * The three have to line up, which is why they ship together: swapping in a tagger that
 * writes a different tag key means swapping in a search engine that understands it.
 *
 * @param {object} [options]  see `extractKeywords`
 * @returns {{forNode: Function, termsOf: Function, forQuery: Function}}
 */
export function keywordTagger(options = {}) {
  return {
    forNode(node) {
      return { keywords: extractKeywords(flattenToText(node.content), options) };
    },

    termsOf(tags) {
      return tags?.keywords ?? [];
    },

    forQuery(query) {
      return extractKeywords(query, options);
    }
  };
}
