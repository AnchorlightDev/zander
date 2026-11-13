// Resolves Fastify's `trustProxy` option.
//
// Fastify 5 fails closed on a *numeric* trustProxy: it never trusts the
// immediate peer, so req.protocol stays "http" behind a TLS-terminating proxy
// and the Secure session cookie is never written. Passing `true` fixes the
// protocol but trusts every X-Forwarded-For hop, so req.ip becomes the
// leftmost entry, which is whatever the client sent, and every per-IP rate
// limit is bypassable.
//
// A hop-count *function* gets both right: the socket peer (i = 0) is trusted,
// so X-Forwarded-Proto is honoured, and only the last `hops` entries of the
// chain are walked, so req.ip is the address the outermost trusted proxy saw.

export const DEFAULT_HTTPS_PROXY_HOPS = 1;

export function parseTrustProxyHops(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === "") return null;
  const text = String(raw).trim();
  if (!/^\d+$/.test(text)) return null;
  return Number.parseInt(text, 10);
}

export function buildHopTrust(hops) {
  return function trustHop(_addr, i) {
    return i < hops;
  };
}

/**
 * @param {string|undefined} rawHops - TRUST_PROXY_HOPS
 * @param {boolean} isHttpsDeployment
 * @returns {{ trustProxy: false | Function, hops: number }}
 */
export function resolveTrustProxy(rawHops, isHttpsDeployment) {
  const parsed = parseTrustProxyHops(rawHops);
  const hops = parsed ?? (isHttpsDeployment ? DEFAULT_HTTPS_PROXY_HOPS : 0);
  if (hops <= 0) return { trustProxy: false, hops: 0 };
  return { trustProxy: buildHopTrust(hops), hops };
}
