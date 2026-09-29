import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { createProxyPool, getProxyPools, updateProxyPool } from "@/models";
import { buildCloudflareRelayWorker, normalizeWorkerName } from "@/lib/cloudflare/relayWorker";

const CLOUDFLARE_API = "https://api.cloudflare.com/client/v4";
const ACCOUNT_ID_PATTERN = /^[a-f0-9]{32}$/i;

function authHeaders(apiToken, extra = {}) {
  return { Authorization: `Bearer ${apiToken}`, ...extra };
}

async function cloudflareError(response, fallback) {
  const payload = await response.json().catch(() => null);
  return payload?.errors?.map((item) => item.message).filter(Boolean).join("; ") || fallback;
}

async function testDeployedRelay(deployUrl, relaySecret) {
  let lastError = "Relay health check failed";
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
    try {
      const response = await fetch(deployUrl, {
        method: "GET",
        headers: {
          "x-relay-auth": relaySecret,
          "x-relay-target": "https://ip.bwpro.link",
          "x-relay-path": "/",
        },
        signal: AbortSignal.timeout(10000),
      });
      if (response.ok) return;
      lastError = `Relay health check returned HTTP ${response.status}`;
    } catch (error) {
      lastError = error?.message || lastError;
    }
  }
  throw new Error(lastError);
}

async function saveProxyPool(projectName, deployUrl, relaySecret) {
  const pools = await getProxyPools();
  const existing = pools.find((pool) => pool.type === "cloudflare" && pool.name === projectName);
  const data = {
    name: projectName,
    proxyUrl: deployUrl,
    relaySecret,
    type: "cloudflare",
    noProxy: "",
    isActive: true,
    strictProxy: true,
    testStatus: "active",
    lastTestedAt: new Date().toISOString(),
    lastError: null,
  };
  return existing ? updateProxyPool(existing.id, data) : createProxyPool(data);
}

// POST /api/proxy-pools/cloudflare-deploy
export async function POST(request) {
  let workerScriptUrl = "";
  let apiToken = "";
  let workerExisted = false;

  try {
    const body = await request.json();
    const accountId = String(body.accountId || "").trim();
    apiToken = String(body.apiToken || "").trim();
    const projectName = normalizeWorkerName(body.projectName || `relay-${Date.now().toString(36)}`);

    if (!ACCOUNT_ID_PATTERN.test(accountId)) {
      return NextResponse.json({ error: "Cloudflare Account ID must be a 32-character hexadecimal ID" }, { status: 400 });
    }
    if (!apiToken) {
      return NextResponse.json({ error: "Cloudflare API Token is required" }, { status: 400 });
    }

    workerScriptUrl = `${CLOUDFLARE_API}/accounts/${accountId}/workers/scripts/${projectName}`;
    const existingResponse = await fetch(workerScriptUrl, { headers: authHeaders(apiToken) });
    workerExisted = existingResponse.ok;

    const relaySecret = randomBytes(32).toString("base64url");
    const formData = new FormData();
    formData.append("metadata", new Blob([JSON.stringify({
      main_module: "index.js",
      compatibility_date: "2026-03-20",
      observability: { enabled: true },
    })], { type: "application/json" }), "metadata.json");
    formData.append("index.js", new Blob([buildCloudflareRelayWorker()], { type: "application/javascript+module" }), "index.js");

    const uploadResponse = await fetch(workerScriptUrl, {
      method: "PUT",
      headers: authHeaders(apiToken),
      body: formData,
    });
    if (!uploadResponse.ok) {
      const message = await cloudflareError(uploadResponse, "Failed to upload Worker to Cloudflare");
      return NextResponse.json({ error: message }, { status: uploadResponse.status });
    }

    const secretResponse = await fetch(`${workerScriptUrl}/secrets`, {
      method: "PUT",
      headers: authHeaders(apiToken, { "Content-Type": "application/json" }),
      body: JSON.stringify({ name: "RELAY_SECRET", text: relaySecret, type: "secret_text" }),
    });
    if (!secretResponse.ok) {
      throw new Error(await cloudflareError(secretResponse, "Failed to secure Cloudflare Worker"));
    }

    const enableResponse = await fetch(`${workerScriptUrl}/subdomain`, {
      method: "POST",
      headers: authHeaders(apiToken, { "Content-Type": "application/json" }),
      body: JSON.stringify({ enabled: true, previews_enabled: false }),
    });
    if (!enableResponse.ok) {
      throw new Error(await cloudflareError(enableResponse, "Failed to enable workers.dev route"));
    }

    const subdomainResponse = await fetch(`${CLOUDFLARE_API}/accounts/${accountId}/workers/subdomain`, {
      headers: authHeaders(apiToken),
    });
    if (!subdomainResponse.ok) {
      throw new Error(await cloudflareError(subdomainResponse, "Failed to retrieve workers.dev subdomain"));
    }
    const subdomainPayload = await subdomainResponse.json();
    const subdomain = subdomainPayload?.result?.subdomain;
    if (!subdomain) throw new Error("Cloudflare workers.dev subdomain is not configured for this account");

    const deployUrl = `https://${projectName}.${subdomain}.workers.dev`;
    await testDeployedRelay(deployUrl, relaySecret);
    const proxyPool = await saveProxyPool(projectName, deployUrl, relaySecret);
    const publicProxyPool = { ...proxyPool };
    delete publicProxyPool.relaySecret;

    return NextResponse.json({ proxyPool: publicProxyPool, deployUrl, secured: true }, { status: 201 });
  } catch (error) {
    if (workerScriptUrl && apiToken && !workerExisted) {
      await fetch(workerScriptUrl, { method: "DELETE", headers: authHeaders(apiToken) }).catch(() => null);
    }
    console.error("Cloudflare relay deployment failed:", error?.message || error);
    return NextResponse.json({ error: error?.message || "Deploy failed" }, { status: 500 });
  }
}
