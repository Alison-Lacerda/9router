import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { formatOAuthError, wrapOAuthFetchError } from "../../src/lib/oauth/providerHelpers.js";
import kiro from "../../src/lib/oauth/providers/kiro.js";

const originalFetch = global.fetch;

describe("OAuth error formatting and Kiro fetch diagnostics", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    global.fetch = originalFetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("includes nested cause and AggregateError codes while stripping URL queries and proxy credentials", () => {
    const agg = new AggregateError(
      [
        Object.assign(new Error("connect ECONNREFUSED 1.2.3.4:443"), { code: "ECONNREFUSED" }),
        Object.assign(new Error("connect ENETUNREACH ::1:443"), { code: "ENETUNREACH" }),
      ],
      "All connection attempts failed"
    );
    const err = new Error("Client registration request failed (oidc.us-east-1.amazonaws.com): fetch failed", {
      cause: Object.assign(new TypeError("fetch failed via http://user:pass@proxy.local:8080/x?token=secret"), {
        cause: agg,
      }),
    });

    const formatted = formatOAuthError(err);
    expect(formatted).toContain("oidc.us-east-1.amazonaws.com");
    expect(formatted).toContain("ECONNREFUSED");
    expect(formatted).toContain("ENETUNREACH");
    expect(formatted).not.toContain("user:pass");
    expect(formatted).not.toContain("token=secret");
  });

  it("wraps Kiro registerClient network failures with step and host while preserving cause", async () => {
    const tlsCause = Object.assign(new Error("SSL_HANDSHAKE_FAILURE"), { code: "ERR_SSL_SSL_HANDSHAKE_FAILURE" });
    const fetchErr = new TypeError("fetch failed", { cause: tlsCause });
    global.fetch = vi.fn().mockRejectedValue(fetchErr);

    let caught;
    try {
      await kiro.requestDeviceCode(kiro.config, "challenge");
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeTruthy();
    expect(caught.message).toContain("Client registration request failed (oidc.us-east-1.amazonaws.com)");
    expect(caught.cause).toBe(fetchErr);
    expect(formatOAuthError(caught)).toContain("ERR_SSL_SSL_HANDSHAKE_FAILURE");
  });

  it("wrapOAuthFetchError handles invalid URLs safely", () => {
    const err = wrapOAuthFetchError("Token poll request failed", "not-a-url", new Error("boom"));
    expect(err.message).toBe("Token poll request failed (unknown-host): boom");
  });
});
