const WORKER_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function normalizeWorkerName(value) {
  const name = String(value || "").trim().toLowerCase();
  if (!WORKER_NAME_PATTERN.test(name)) {
    throw new Error("Worker name must contain only lowercase letters, numbers, and hyphens (1-63 characters)");
  }
  return name;
}

export function buildCloudflareRelayWorker() {
  return `
const encoder = new TextEncoder();
const BLOCKED_HOSTS = new Set(["localhost", "localhost.localdomain", "metadata.google.internal"]);

function timingSafeEqual(left, right) {
  const a = encoder.encode(left || "");
  const b = encoder.encode(right || "");
  let difference = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (a[index % (a.length || 1)] || 0) ^ (b[index % (b.length || 1)] || 0);
  }
  return difference === 0;
}

function isPrivateHostname(hostname) {
  const host = hostname.toLowerCase().replace(/^\\[|\\]$/g, "");
  if (BLOCKED_HOSTS.has(host) || host.endsWith(".localhost") || host.endsWith(".local")) return true;

  if (host.includes(":")) {
    return host === "::1" || host === "::" || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe8") || host.startsWith("fe9") || host.startsWith("fea") || host.startsWith("feb");
  }

  const parts = host.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  return parts[0] === 10 || parts[0] === 127 || parts[0] === 0 ||
    (parts[0] === 169 && parts[1] === 254) ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && parts[1] === 168) ||
    (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127);
}

function jsonResponse(status, error) {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

async function handleRequest(request) {
    if (typeof RELAY_SECRET !== "string" || !RELAY_SECRET || !timingSafeEqual(request.headers.get("x-relay-auth"), RELAY_SECRET)) {
      return jsonResponse(401, "Unauthorized relay request");
    }

    const target = request.headers.get("x-relay-target");
    const relayPath = request.headers.get("x-relay-path") || "/";
    if (!target) return jsonResponse(400, "Missing x-relay-target header");

    let targetUrl;
    try {
      const base = new URL(target);
      if (base.protocol !== "https:" || base.username || base.password || base.pathname !== "/" || base.search || base.hash) {
        return jsonResponse(400, "Invalid relay target");
      }
      if (isPrivateHostname(base.hostname)) return jsonResponse(403, "Private relay target blocked");
      targetUrl = new URL(relayPath, base);
      if (targetUrl.origin !== base.origin) return jsonResponse(400, "Invalid relay path");
    } catch {
      return jsonResponse(400, "Invalid relay target");
    }

    const headers = new Headers(request.headers);
    for (const name of [
      "x-relay-target", "x-relay-path", "x-relay-auth", "host", "connection",
      "content-length", "transfer-encoding", "cf-connecting-ip", "cf-ipcountry",
      "cf-ray", "cf-visitor", "x-forwarded-for", "x-forwarded-proto"
    ]) headers.delete(name);

    try {
      const response = await fetch(targetUrl, {
        method: request.method,
        headers,
        body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
        redirect: "manual",
      });
      const responseHeaders = new Headers(response.headers);
      responseHeaders.set("cache-control", "no-store");
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
      });
    } catch (error) {
      return jsonResponse(502, error?.message || "Relay upstream request failed");
    }
}

addEventListener("fetch", (event) => {
  event.respondWith(handleRequest(event.request));
});
`;
}
