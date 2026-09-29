function normalizeHeaders(headersInit) {
  if (headersInit instanceof Headers) {
    return Object.fromEntries(headersInit.entries());
  }
  if (Array.isArray(headersInit)) {
    return Object.fromEntries(headersInit);
  }
  return { ...(headersInit || {}) };
}

export function buildRelayTarget(targetUrl) {
  const parsed = new URL(targetUrl);
  return {
    target: parsed.origin,
    path: `${parsed.pathname}${parsed.search}`,
  };
}

export function buildRelayHeaders(headersInit, targetUrl, relaySecret = "") {
  const { target, path } = buildRelayTarget(targetUrl);
  const headers = {
    ...normalizeHeaders(headersInit),
    "x-relay-target": target,
    "x-relay-path": path,
  };

  if (relaySecret) {
    headers["x-relay-auth"] = relaySecret;
  }

  return headers;
}
