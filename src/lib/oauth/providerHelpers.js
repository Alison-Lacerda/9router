import { buildKiroIdentityHeaders } from "open-sse/shared/kiroIdentity.js";

const BASE64_BLOCK_SIZE = 4;

function validateXaiOAuthEndpoint(rawUrl, field) {
  const value = String(rawUrl || "").trim();
  if (!value) throw new Error(`xai discovery ${field} is empty`);
  let parsed;
  try { parsed = new URL(value); } catch (err) {
    throw new Error(`xai discovery ${field} is invalid: ${err.message}`);
  }
  if (parsed.protocol !== "https:") throw new Error(`xai discovery ${field} must use https: ${value}`);
  const host = parsed.hostname.toLowerCase().trim();
  if (host !== "x.ai" && !host.endsWith(".x.ai")) {
    throw new Error(`xai discovery ${field} host ${host} is not on x.ai`);
  }
  return value;
}

function decodeXaiIdTokenEmail(idToken) {
  if (!idToken || typeof idToken !== "string") return undefined;
  const parts = idToken.split(".");
  if (parts.length !== 3) return undefined;
  try {
    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padding = (BASE64_BLOCK_SIZE - (base64.length % BASE64_BLOCK_SIZE)) % BASE64_BLOCK_SIZE;
    const json = Buffer.from(base64 + "=".repeat(padding), "base64").toString("utf8");
    const payload = JSON.parse(json);
    return payload.email || payload.preferred_username || payload.sub || undefined;
  } catch {
    return undefined;
  }
}

function decodeJwtPayload(jwt) {
  try {
    if (!jwt || typeof jwt !== "string") return null;
    const parts = jwt.split(".");
    if (parts.length !== 3) return null;
    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const missingPadding = (BASE64_BLOCK_SIZE - (base64.length % BASE64_BLOCK_SIZE)) % BASE64_BLOCK_SIZE;
    const padded = base64 + "=".repeat(missingPadding);
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

function extractEmailFromAccessToken(accessToken) {
  const payload = decodeJwtPayload(accessToken);
  if (!payload) return undefined;
  return payload.email || payload.preferred_username || payload.sub || undefined;
}

export async function fetchKiroProfileArn(accessToken) {
  if (!accessToken) return null;
  try {
    const response = await fetch("https://codewhisperer.us-east-1.amazonaws.com/ListAvailableProfiles", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${accessToken}`,
        ...buildKiroIdentityHeaders({ accessToken }),
      },
      body: JSON.stringify({ maxResults: 10 }),
    });
    if (!response.ok) return null;
    const data = await response.json();
    return data.profiles?.find((p) => p.arn?.trim())?.arn?.trim() || null;
  } catch {
    return null;
  }
}

export function extractCodexAccountInfo(idToken) {
  const payload = decodeJwtPayload(idToken);
  if (!payload) return {};
  const chatgpt = payload["https://api.openai.com/auth"] || {};
  return {
    email: payload.email,
    chatgptAccountId: chatgpt.chatgpt_account_id || payload.account_id,
    chatgptPlanType: chatgpt.chatgpt_plan_type || payload.plan_type,
  };
}

function sanitizeOAuthErrorText(text) {
  return String(text || "")
    .replace(/([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)([^/@\s]+)@/g, "$1")
    .replace(/(https?:\/\/[^\s?#]+)\?[^\s#]*/g, "$1")
    .trim();
}

function describeOAuthErrorNode(node) {
  if (!node || typeof node !== "object") return sanitizeOAuthErrorText(node);
  if (Array.isArray(node.errors) && node.errors.length > 0) {
    const items = [];
    for (const sub of node.errors.slice(0, 3)) {
      const desc = describeOAuthErrorNode(sub);
      if (desc && !items.includes(desc)) items.push(desc);
    }
    if (items.length > 0) return items.join("; ");
  }
  const code = typeof node.code === "string" ? node.code.trim() : "";
  const msg = sanitizeOAuthErrorText(node.message || node.reason || "");
  if (code && msg && !msg.includes(code)) return `${code}: ${msg}`;
  return msg || code;
}

export function formatOAuthError(error) {
  const baseMsg = sanitizeOAuthErrorText(error?.message || String(error || "Unknown OAuth error"));
  const parts = [];
  const seen = new Set();
  if (error && typeof error === "object") seen.add(error);

  let current = error?.cause;
  for (let depth = 0; current && depth < 4; depth++) {
    if (typeof current === "object") {
      if (seen.has(current)) break;
      seen.add(current);
    }
    const desc = describeOAuthErrorNode(current);
    if (desc && !baseMsg.includes(desc) && !parts.includes(desc)) {
      parts.push(desc);
    }
    current = typeof current === "object" ? current.cause : null;
  }

  return parts.length > 0 ? `${baseMsg} (cause: ${parts.join(" -> ")})` : baseMsg;
}

export function wrapOAuthFetchError(step, targetUrl, error) {
  let host = "unknown-host";
  try {
    host = new URL(String(targetUrl)).host || host;
  } catch {}
  const msg = sanitizeOAuthErrorText(error?.message || "fetch failed");
  return new Error(`${step} (${host}): ${msg}`, { cause: error });
}

export {
  BASE64_BLOCK_SIZE,
  validateXaiOAuthEndpoint,
  decodeXaiIdTokenEmail,
  decodeJwtPayload,
  extractEmailFromAccessToken,
};
