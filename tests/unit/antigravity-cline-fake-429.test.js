import { describe, expect, it } from "vitest";

import { AntigravityExecutor } from "../../open-sse/executors/antigravity.js";
import { openaiToAntigravityRequest } from "../../open-sse/translator/request/openai-to-gemini.js";

// Line 1 of the Cline system prompt, verbatim, made Antigravity answer
// 429 RESOURCE_EXHAUSTED while the account had quota (bisected 2026-11-28).
// It is the only trigger in the whole 58-line prompt.
const TRIGGER = "You are Cline, an AI coding agent. Your primary goal is to assist users with various coding tasks by leveraging your knowledge and the tools at your disposal. Given the user's prompt, you should use the tools available to you to answer user's question.";

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

describe("Antigravity rewrites the Cline line that triggers a fake 429", () => {
  it("replaces the Cline identity and keeps the rest", () => {
    const text = systemTextSentToAntigravity(
      [TRIGGER, "Review each question carefully and answer it with detailed, accurate information."].join("\n")
    );
    expect(text).not.toContain("Cline");
    expect(text).toContain("You are an AI coding agent.");
    expect(text).toContain("Your primary goal is to assist users with various coding tasks");
    expect(text).toContain("Review each question carefully and answer it with detailed, accurate information.");
  });

  it("keeps the VS Code mention, which does not trigger", () => {
    const text = systemTextSentToAntigravity("3. IDE: VS Code");
    expect(text).toContain("VS Code");
  });
});
