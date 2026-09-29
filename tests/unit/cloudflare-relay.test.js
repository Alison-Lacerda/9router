import assert from "node:assert/strict";
import test from "node:test";

import {
  buildRelayHeaders,
  buildRelayTarget,
} from "../../open-sse/utils/relayProxy.js";
import {
  buildCloudflareRelayWorker,
  normalizeWorkerName,
} from "../../src/lib/cloudflare/relayWorker.js";

test("buildRelayTarget preserves origin, path and query", () => {
  assert.deepEqual(buildRelayTarget("https://api.example.com/v1/models?q=1"), {
    target: "https://api.example.com",
    path: "/v1/models?q=1",
  });
});

test("buildRelayHeaders preserves Headers values and adds relay authentication", () => {
  const headers = new Headers({ authorization: "Bearer provider-token", "content-type": "application/json" });
  const result = buildRelayHeaders(headers, "https://api.example.com/v1/chat", "relay-secret");

  assert.equal(result.authorization, "Bearer provider-token");
  assert.equal(result["content-type"], "application/json");
  assert.equal(result["x-relay-target"], "https://api.example.com");
  assert.equal(result["x-relay-path"], "/v1/chat");
  assert.equal(result["x-relay-auth"], "relay-secret");
});

test("buildRelayHeaders omits relay authentication for legacy relay pools", () => {
  const result = buildRelayHeaders({}, "https://api.example.com", "");
  assert.equal(result["x-relay-auth"], undefined);
});

test("Cloudflare worker requires secret and rejects unsafe targets", () => {
  const source = buildCloudflareRelayWorker();
  assert.match(source, /typeof RELAY_SECRET !== "string"/);
  assert.match(source, /addEventListener\("fetch"/);
  assert.doesNotMatch(source, /export default/);
  assert.match(source, /x-relay-auth/);
  assert.match(source, /timingSafeEqual/);
  assert.match(source, /protocol !== "https:"/);
  assert.match(source, /isPrivateHostname/);
});

test("normalizeWorkerName accepts Cloudflare names and rejects invalid input", () => {
  assert.equal(normalizeWorkerName(" cloudflare-relay "), "cloudflare-relay");
  assert.throws(() => normalizeWorkerName("Bad_Name"), /Worker name/);
  assert.throws(() => normalizeWorkerName("-bad"), /Worker name/);
});
