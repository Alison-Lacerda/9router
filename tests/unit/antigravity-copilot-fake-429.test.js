import { describe, expect, it } from "vitest";

import { AntigravityExecutor } from "../../open-sse/executors/antigravity.js";
import { openaiToAntigravityRequest } from "../../open-sse/translator/request/openai-to-gemini.js";

// Line 1 of the VS Code Copilot system prompt, verbatim, made Antigravity answer
// 429 RESOURCE_EXHAUSTED while the account had quota (bisected 2026-11-28).
// It is the only trigger in the whole 407-line prompt.
const TRIGGER = "Follow Microsoft content policies.";

function systemTextSentToAntigravity(systemContent) {
  const body = openaiToAntigravityRequest("gemini-4-hydrogen-high", {
    messages: [
      { role: "system", content: systemContent },
      { role: "user", content: "hi" },
    ],
  }, true);
  const finalBody = new AntigravityExecutor().transformRequest("gemini-4-hydrogen-high", body, true, {});
  return finalBody.request.systemInstruction.parts.map((p) => p.text).join("\n");
}

describe("Antigravity rewrites the Copilot line that triggers a fake 429", () => {
  it("replaces the Microsoft line and keeps the rest", () => {
    const text = systemTextSentToAntigravity(
      [TRIGGER, "Avoid content that violates copyrights.", "Keep your answers short and impersonal."].join("\n")
    );
    expect(text).not.toContain("Microsoft");
    expect(text).toContain("Follow content policies.");
    expect(text).toContain("Avoid content that violates copyrights.");
    expect(text).toContain("Keep your answers short and impersonal.");
  });

  it("keeps the VS Code mention, which does not trigger", () => {
    const text = systemTextSentToAntigravity(
      "The user works in an IDE called Visual Studio Code which has a concept for editors with open files."
    );
    expect(text).toContain("Visual Studio Code");
  });
});
