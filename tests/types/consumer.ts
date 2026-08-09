/**
 * Typechecked against the generated declarations, not against the source.
 *
 * This exists because `tsc` emitting without error proves nothing about whether the emitted
 * types are usable. Two separate bugs shipped past a clean build during this rewrite: the
 * declarations were once emitted under module names no consumer could resolve, and every
 * mention of `Node` silently resolved to the browser's `Node` instead of ours, so `node.id`
 * typechecked as a DOM property. Both would have been caught here.
 *
 * Nothing runs. If this file compiles under `strict`, the published types work.
 */
import {
  LiminalMemory,
  Pool,
  BM25,
  keywordTagger,
  decayGraph,
  extractKeywords,
  defaults
} from "../../dist/types/index.js";

async function container() {
  const mem = new LiminalMemory({
    defaultPool: "chat",
    now: () => 1000,
    onEvict: async nodes => nodes.length,
    tagger: keywordTagger(),
    engine: () => new BM25({ k1: 1.2, b: 0.4 }),
    graph: decayGraph({ decayMs: 60_000 })
  });

  const node = await mem.create({ content: "the quarterly report", metadata: { source: "chat" } });
  const id: string = node.id;
  const pool: string = node.pool;
  const createdAt: number = node.metadata.createdAt;

  const structural = await mem.create({ content: null });
  const anyContent = await mem.create({ content: { user: "hi", assistant: "hey" } });

  const hits = await mem.search("report", { from: id, limit: 5 });
  const firstId: string = hits[0].id;

  const ranked = await mem.rank("report", { from: node, link: false });
  const score: number = ranked[0].score;
  const rankedId: string = ranked[0].node.id;

  const linked: boolean = mem.link(id, structural.id, 1000);
  const permanent: boolean = mem.link(node, anyContent);
  const edges = mem.neighbors(id);
  const direction: "to" | "from" = edges[0].direction;
  const observedAt: number | undefined = edges[0].observedAt;

  const total: number = mem.size;
  const names: string[] = mem.pools();
  const found = mem.get(id);
  const snapshot = mem.toJSON();
  mem.load(snapshot);
  mem.clear();

  return [pool, createdAt, firstId, score, rankedId, linked, permanent, direction, observedAt, total, names, found];
}

async function pools() {
  const pool = new Pool("docs", { now: Date.now });

  await pool.createMany([{ content: "one" }, { content: "two", id: "named" }]);
  await pool.update("named", { content: "changed", metadata: { revised: true } });

  const byPredicate = await pool.evict(node => node.id === "named");
  const oldest = await pool.evictOldest(1);
  const gone: boolean = pool.remove("named");

  const ids: string[] = pool.ids();
  const size: number = pool.size;
  const has: boolean = pool.has("named");

  return [byPredicate.length, oldest.length, gone, ids, size, has];
}

function customPieces() {
  const tagger = {
    forNode: (node: { content: unknown }) => ({ keywords: [String(node.content)] }),
    termsOf: (tags: { keywords?: string[] }) => tags.keywords ?? [],
    forQuery: (query: string) => [query]
  };

  const pool = new Pool("custom", { tagger });
  const terms: string[] = extractKeywords("the quarterly report", { minLength: 4 });
  const k1: number = defaults.bm25.k1;
  const decayMs: number = defaults.graph.decayMs;
  const minLength: number = defaults.keywords.minLength;

  return [pool.name, terms, k1, decayMs, minLength];
}

export { container, pools, customPieces };
