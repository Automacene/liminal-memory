/**
 * Id generation.
 *
 * Node ids are globally unique across every pool, so a graph edge can point at any node
 * without carrying a pool name alongside it. The generated form is `poolName-uuid`, which
 * makes ids readable while debugging. The pool prefix is decoration only, so `node.pool` is
 * the truth and nothing should ever parse an id to work out where a node lives (a
 * caller-supplied id carries no prefix at all).
 */

/**
 * A v4 UUID, using the strongest source the environment offers.
 *
 * `crypto.randomUUID` covers Node 19+ and browsers, but browsers only expose it in a secure
 * context, so over plain HTTP on a non-localhost address it is undefined, which a script-tag
 * build will hit. `crypto.getRandomValues` has no such restriction, so that is the first
 * fallback. The last resort is `Math.random`, which is weaker but still fine here, because
 * these ids need to be unique rather than unguessable.
 *
 * @returns {string}
 */
export function uuid() {
  const c = globalThis.crypto;

  if (c && typeof c.randomUUID === "function") {
    return c.randomUUID();
  }

  if (c && typeof c.getRandomValues === "function") {
    const bytes = c.getRandomValues(new Uint8Array(16));
    return formatUuid(bytes);
  }

  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  return formatUuid(bytes);
}

/**
 * Lay 16 random bytes out as a v4 UUID string, setting the version and variant bits.
 * @param {Uint8Array} bytes
 * @returns {string}
 */
function formatUuid(bytes) {
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10xx

  const hex = [];
  for (let i = 0; i < 16; i++) hex.push(bytes[i].toString(16).padStart(2, "0"));

  return (
    hex.slice(0, 4).join("") + "-" +
    hex.slice(4, 6).join("") + "-" +
    hex.slice(6, 8).join("") + "-" +
    hex.slice(8, 10).join("") + "-" +
    hex.slice(10, 16).join("")
  );
}

/**
 * The default id for a new node in a pool.
 * @param {string} poolName
 * @returns {string}
 */
export function generateId(poolName) {
  return `${poolName}-${uuid()}`;
}
