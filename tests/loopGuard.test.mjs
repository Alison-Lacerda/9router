import test from "node:test";
import assert from "node:assert/strict";
import {
  detectLoopInMessages,
  applyLoopGuard,
  isCoolingDown,
  cooldownSnapshot,
  sessionKeyFromBody,
} from "../open-sse/services/loopGuard.js";

function tc(name, args) {
  return { id: "call_1", type: "function", function: { name, arguments: JSON.stringify(args) } };
}
function assistantToolMsg(...calls) {
  return { role: "assistant", content: null, tool_calls: calls };
}
function userMsg(text) {
  return { role: "user", content: text };
}
function toolResult() {
  return { role: "tool", tool_call_id: "call_1", content: "..." };
}

test("paginacao legitima do mesmo arquivo NAO dispara loop", () => {
  const msgs = [
    userMsg("leia o arquivo grande em partes"),
    assistantToolMsg(tc("read", { path: "/repo/big.js", offset: 1, limit: 200 })),
    toolResult(),
    assistantToolMsg(tc("read", { path: "/repo/big.js", offset: 201, limit: 200 })),
    toolResult(),
    assistantToolMsg(tc("read", { path: "/repo/big.js", offset: 401, limit: 200 })),
    toolResult(),
  ];
  assert.equal(detectLoopInMessages(msgs).loop, false);
});

test("uma re-conferida ocasional NAO dispara loop", () => {
  const msgs = [
    assistantToolMsg(tc("read", { path: "/repo/a.js", offset: 1, limit: 200 })),
    toolResult(),
    assistantToolMsg(tc("read", { path: "/repo/a.js", offset: 201, limit: 200 })),
    toolResult(),
    assistantToolMsg(tc("read", { path: "/repo/a.js", offset: 1, limit: 200 })),
    toolResult(),
  ];
  assert.equal(detectLoopInMessages(msgs).loop, false);
});

test("incidente real: releituras sobrepostas do mesmo arquivo SEM escrita dispara loop", () => {
  const msgs = [
    userMsg("edite o MessageInput"),
    assistantToolMsg(tc("read", { path: "/repo/MessageInput/index.js", offset: 1, limit: 50 })),
    toolResult(),
    assistantToolMsg(tc("read", { path: "/repo/MessageInput/index.js", offset: 51, limit: 50 })),
    toolResult(),
    assistantToolMsg(tc("read", { path: "/repo/MessageInput/index.js", offset: 1, limit: 150 })),
    toolResult(),
    assistantToolMsg(tc("read", { path: "/repo/MessageInput/index.js", offset: 794, limit: 100 })),
    toolResult(),
    assistantToolMsg(tc("read", { path: "/repo/MessageInput/index.js", offset: 1, limit: 200 })),
    toolResult(),
  ];
  const det = detectLoopInMessages(msgs);
  assert.equal(det.loop, true);
  assert.equal(det.detail.kind, "reread");
  assert.ok(det.detail.count >= 3);
  assert.ok(det.detail.rereads >= 2);
});

test("comando identico repetido 3x (sed com numeros variando) dispara loop", () => {
  const msgs = [
    assistantToolMsg(tc("exec", { command: "sed -n '100,150p' /repo/a.js" })),
    toolResult(),
    assistantToolMsg(tc("exec", { command: "sed -n '200,250p' /repo/a.js" })),
    toolResult(),
    assistantToolMsg(tc("exec", { command: "sed -n '300,350p' /repo/a.js" })),
    toolResult(),
  ];
  const det = detectLoopInMessages(msgs);
  assert.equal(det.loop, true);
  assert.equal(det.detail.kind, "repeat");
});

test("escrita no meio interrompe o streak e NAO dispara loop", () => {
  const msgs = [
    assistantToolMsg(tc("read", { path: "/repo/a.js", offset: 1, limit: 100 })),
    toolResult(),
    assistantToolMsg(tc("read", { path: "/repo/a.js", offset: 1, limit: 100 })),
    toolResult(),
    assistantToolMsg(tc("edit", { path: "/repo/a.js", oldText: "x", newText: "y" })),
    toolResult(),
    assistantToolMsg(tc("read", { path: "/repo/a.js", offset: 1, limit: 100 })),
    toolResult(),
  ];
  assert.equal(detectLoopInMessages(msgs).loop, false);
});

test("exec com redirect conta como escrita e nao dispara", () => {
  const msgs = [
    assistantToolMsg(tc("exec", { command: "ls /repo > /tmp/x.txt" })),
    toolResult(),
    assistantToolMsg(tc("exec", { command: "ls /repo > /tmp/x.txt" })),
    toolResult(),
    assistantToolMsg(tc("exec", { command: "ls /repo > /tmp/x.txt" })),
    toolResult(),
  ];
  assert.equal(detectLoopInMessages(msgs).loop, false);
});

test("historico curto nao dispara", () => {
  const msgs = [
    assistantToolMsg(tc("read", { path: "/repo/a.js" })),
    toolResult(),
    assistantToolMsg(tc("read", { path: "/repo/a.js" })),
  ];
  assert.equal(detectLoopInMessages(msgs).loop, false);
});

test("loop fora da cauda (lookback) nao dispara", () => {
  const msgs = [
    assistantToolMsg(tc("read", { path: "/repo/a.js", offset: 1, limit: 50 })),
    toolResult(),
    assistantToolMsg(tc("read", { path: "/repo/a.js", offset: 1, limit: 50 })),
    toolResult(),
    assistantToolMsg(tc("read", { path: "/repo/a.js", offset: 1, limit: 50 })),
    toolResult(),
  ];
  for (let i = 0; i < 16; i++) msgs.push(userMsg(`mensagem ${i}`));
  assert.equal(detectLoopInMessages(msgs).loop, false);
});

test("applyLoopGuard: strike no primeiro modelo, rotaciona e aplica cooldown", () => {
  const body = {
    messages: [
      { role: "system", content: "sessao-loopguard-rotacao-1" },
      userMsg("edite o campo"),
      assistantToolMsg(tc("read", { path: "/repo/a.js", offset: 1, limit: 50 })),
      toolResult(),
      assistantToolMsg(tc("read", { path: "/repo/a.js", offset: 10, limit: 50 })),
      toolResult(),
      assistantToolMsg(tc("read", { path: "/repo/a.js", offset: 5, limit: 50 })),
      toolResult(),
    ],
  };
  const models = ["spark/loopA", "wonder/loopB", "gemini/loopC"];
  const out = applyLoopGuard({ body, settings: {}, models, comboName: "agent-pro", log: null });
  assert.deepEqual(out, ["wonder/loopB", "gemini/loopC"]);
  assert.equal(isCoolingDown("spark/loopA"), true);
  assert.equal(isCoolingDown("wonder/loopB"), false);
  assert.ok(cooldownSnapshot().some((c) => c.model === "spark/loopA"));
});

test("applyLoopGuard: dedupe por sessao nao empilha strikes em menos de 60s", () => {
  const body = {
    messages: [
      { role: "system", content: "sessao-loopguard-dedupe-1" },
      userMsg("edite o campo"),
      assistantToolMsg(tc("read", { path: "/repo/b.js", offset: 1, limit: 50 })),
      toolResult(),
      assistantToolMsg(tc("read", { path: "/repo/b.js", offset: 3, limit: 50 })),
      toolResult(),
      assistantToolMsg(tc("read", { path: "/repo/b.js", offset: 2, limit: 50 })),
      toolResult(),
    ],
  };
  const out1 = applyLoopGuard({ body, settings: {}, models: ["spark/dedupeA", "wonder/dedupeB"], comboName: "agent-pro", log: null });
  assert.deepEqual(out1, ["wonder/dedupeB"]);
  // Mesma sessao dentro de 60s: sem novo strike em wonder/dedupeB
  const out2 = applyLoopGuard({ body, settings: {}, models: ["wonder/dedupeB", "gemini/dedupeC"], comboName: "agent-pro", log: null });
  assert.deepEqual(out2, ["wonder/dedupeB", "gemini/dedupeC"]);
  assert.equal(isCoolingDown("wonder/dedupeB"), false);
});

test("applyLoopGuard: todos em cooldown devolve lista original (nunca vazia)", () => {
  const body = {
    messages: [
      { role: "system", content: "sessao-loopguard-todos-1" },
      userMsg("edite o campo"),
      assistantToolMsg(tc("exec", { command: "grep -n anchorX /repo/c.js" })),
      toolResult(),
      assistantToolMsg(tc("exec", { command: "grep -n anchorX /repo/c.js" })),
      toolResult(),
      assistantToolMsg(tc("exec", { command: "grep -n anchorX /repo/c.js" })),
      toolResult(),
    ],
  };
  // Primeira passada esfria all1
  const out1 = applyLoopGuard({ body, settings: {}, models: ["spark/all1", "wonder/all2"], comboName: "agent-pro", log: null });
  assert.deepEqual(out1, ["wonder/all2"]);
  // Nova sessao: target wonder/all2 esfria; spark/all1 ja estava -> lista cheia de volta
  const body2 = { messages: [userMsg("outra sessao"), ...body.messages.slice(1)] };
  const out2 = applyLoopGuard({ body: body2, settings: {}, models: ["wonder/all2", "spark/all1"], comboName: "agent-pro", log: null });
  assert.deepEqual(out2, ["wonder/all2", "spark/all1"]);
});

test("applyLoopGuard: lista de 1 modelo e body sem loop passam ilesos", () => {
  const body = { messages: [userMsg("oi"), { role: "assistant", content: "ola" }] };
  const single = applyLoopGuard({ body, settings: {}, models: ["spark/only1"], comboName: "agent-pro", log: null });
  assert.deepEqual(single, ["spark/only1"]);
  const clean = applyLoopGuard({ body, settings: {}, models: ["spark/clean1", "spark/clean2"], comboName: "agent-pro", log: null });
  assert.deepEqual(clean, ["spark/clean1", "spark/clean2"]);
});

test("applyLoopGuard: desativado via settings devolve lista intacta mesmo com loop", () => {
  const body = {
    messages: [
      userMsg("edite"),
      assistantToolMsg(tc("exec", { command: "grep -n zzz /repo/d.js" })),
      toolResult(),
      assistantToolMsg(tc("exec", { command: "grep -n zzz /repo/d.js" })),
      toolResult(),
      assistantToolMsg(tc("exec", { command: "grep -n zzz /repo/d.js" })),
      toolResult(),
    ],
  };
  const out = applyLoopGuard({ body, settings: { loopGuard: { enabled: false } }, models: ["spark/off1", "wonder/off2"], comboName: "agent-pro", log: null });
  assert.deepEqual(out, ["spark/off1", "wonder/off2"]);
  assert.equal(isCoolingDown("spark/off1"), false);
});

test("sessionKeyFromBody e estavel para o mesmo inicio de conversa", () => {
  const base = { messages: [{ role: "system", content: "sys X" }, userMsg("primeira mensagem")] };
  const k1 = sessionKeyFromBody(base);
  const k2 = sessionKeyFromBody({ messages: [...base.messages, assistantToolMsg(tc("read", { path: "/x" }))] });
  assert.equal(k1, k2);
  assert.match(k1, /^[0-9a-f]{24}$/);
});
