import { createHash } from "node:crypto";

// Loop & hallucination guard: rotates a combo away from a model that keeps
// re-issuing the same read-only tool calls without ever making progress.
// State is in-memory on purpose: cooldowns are short-lived and losing them on
// restart only costs one extra looped turn before the signal re-arms.

const WRITE_TOOL_RE = /(edit|write|apply_patch|create|update|delete|remove|kill|move|submit|paste|spawn|worktree)/i;
const READ_TOOL_NAMES = new Set(["read", "read_file", "readfile", "open_file", "view_file", "cat", "view"]);

const sessionLastSignal = new Map(); // sessionKey -> last signal ts (dedupe)
const modelCooldown = new Map();     // model -> cooldown until ts

const DEFAULTS = {
  enabled: true,
  minRepeats: 3,
  cooldownMinutes: 30,
  lookback: 16,
};

function configFrom(settings) {
  const out = { ...DEFAULTS };
  const lg = settings && typeof settings === "object" ? settings.loopGuard : null;
  if (lg && typeof lg === "object") {
    for (const k of Object.keys(DEFAULTS)) {
      if (lg[k] !== undefined && lg[k] !== null) out[k] = lg[k];
    }
  }
  if (process.env.LOOPGUARD_DISABLED === "1") out.enabled = false;
  if (process.env.LOOPGUARD_COOLDOWN_MINUTES) {
    const v = parseInt(process.env.LOOPGUARD_COOLDOWN_MINUTES, 10);
    if (Number.isFinite(v) && v > 0) out.cooldownMinutes = v;
  }
  return out;
}

function firstString(...vals) {
  for (const v of vals) if (typeof v === "string" && v) return v;
  return "";
}

function parseArgs(tc) {
  const raw = tc?.function?.arguments ?? tc?.arguments;
  if (raw && typeof raw === "object") return raw;
  if (typeof raw === "string") {
    try { return JSON.parse(raw); } catch { return {}; }
  }
  return {};
}

function commandOf(args) {
  return firstString(args.command, args.cmd, args.script, args.code, args.body);
}

function isWriteCall(fn, args) {
  if (WRITE_TOOL_RE.test(fn)) return true;
  const cmd = commandOf(args);
  if (cmd && (/\btee\b/.test(cmd) || />{1,2}\s*\S/.test(cmd))) return true;
  if (typeof args.patch === "string" && args.patch.trim()) return true;
  if (typeof args.newText === "string" && args.newText.trim()) return true;
  return false;
}

// Normalized identity of a read-only call: digits collapse so "sed -n '100,150p'"
// and "sed -n '200,250p'" on the same file count as repeats, while different
// files/commands stay distinct.
function normalizeCommand(cmd) {
  return String(cmd).replace(/\d+/g, "#").slice(0, 120);
}

function buildCall(tc) {
  const fn = String(tc?.function?.name || tc?.name || "");
  const args = parseArgs(tc);
  const path = firstString(args.path, args.file_path, args.file, args.filePath, args.filename);
  const cmd = commandOf(args);
  const offset = Number.isFinite(Number(args.offset)) ? Number(args.offset) : null;
  const limit = Number.isFinite(Number(args.limit) || Number(args.lines))
    ? (Number(args.limit) || Number(args.lines))
    : null;

  let key;
  if (READ_TOOL_NAMES.has(fn.toLowerCase()) && path) {
    key = `read|${path}`;
  } else if (cmd) {
    key = `${fn}|${normalizeCommand(cmd)}`;
  } else {
    key = `${fn}|${String(JSON.stringify(args)).replace(/\d+/g, "#").slice(0, 160)}`;
  }

  return { fn, path, cmd, offset, limit, key, isWrite: isWriteCall(fn, args) };
}

// Re-read heuristic for paged reads of one file: page N+1 restarting before the
// end of page N (minus a small margin) is a re-read, not forward pagination.
function countOverlappingRereads(calls) {
  const byPath = new Map();
  let rereads = 0;
  for (const c of calls) {
    if (c.offset === null || !c.path) continue;
    const prev = byPath.get(c.path);
    if (prev && c.offset < prev.offset + (prev.limit || 200) - 10) rereads += 1;
    byPath.set(c.path, c);
  }
  return rereads;
}

export function detectLoopInMessages(messages, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  if (!Array.isArray(messages) || messages.length < o.minRepeats) {
    return { loop: false };
  }
  const tail = messages.slice(-o.lookback);
  const calls = [];
  for (const m of tail) {
    if (!m || m.role !== "assistant" || !Array.isArray(m.tool_calls)) continue;
    for (const tc of m.tool_calls) calls.push(buildCall(tc));
  }
  if (calls.length < o.minRepeats) return { loop: false };

  // Progress beats looping: everything after the most recent write is the
  // current read-only streak; a write means the model is advancing.
  let lastWrite = -1;
  for (let i = calls.length - 1; i >= 0; i--) {
    if (calls[i].isWrite) { lastWrite = i; break; }
  }
  const streak = calls.slice(lastWrite + 1);
  if (streak.length < o.minRepeats) return { loop: false };

  // Exact repeats of the same normalized read-only call.
  const counts = new Map();
  for (const c of streak) {
    if (c.offset !== null && READ_TOOL_NAMES.has(c.fn.toLowerCase())) continue; // paged reads judged below
    counts.set(c.key, (counts.get(c.key) || 0) + 1);
  }
  for (const [key, n] of counts) {
    if (n >= o.minRepeats) return { loop: true, detail: { kind: "repeat", key, count: n } };
  }

  // Overlapping re-reads of the same file (the "15 reads with drifting offsets" incident).
  const readStreak = streak.filter((c) => READ_TOOL_NAMES.has(c.fn.toLowerCase()) && c.path);
  if (readStreak.length >= o.minRepeats) {
    const perPath = new Map();
    for (const c of readStreak) perPath.set(c.path, (perPath.get(c.path) || 0) + 1);
    for (const [path, n] of perPath) {
      if (n >= o.minRepeats) {
        const rereads = countOverlappingRereads(readStreak.filter((c) => c.path === path));
        if (rereads >= 2) return { loop: true, detail: { kind: "reread", path, count: n, rereads } };
      }
    }
  }

  return { loop: false };
}

export function sessionKeyFromBody(body) {
  const msgs = body?.messages;
  const system = Array.isArray(msgs)
    ? (msgs.find((m) => m && m.role === "system")?.content || "")
    : "";
  const firstUser = Array.isArray(msgs)
    ? (msgs.find((m) => m && m.role === "user")?.content || "")
    : "";
  const seed = `${String(system).slice(0, 2000)}|${String(firstUser).slice(0, 400)}`;
  return createHash("sha1").update(seed).digest("hex").slice(0, 24);
}

export function isCoolingDown(model, now = Date.now()) {
  const until = modelCooldown.get(model) || 0;
  return until > now;
}

export function cooldownSnapshot(now = Date.now()) {
  const out = [];
  for (const [m, until] of modelCooldown) if (until > now) out.push({ model: m, until });
  return out;
}

function prune(now) {
  if (modelCooldown.size > 5000) {
    for (const [m, until] of modelCooldown) if (until <= now) modelCooldown.delete(m);
  }
  if (sessionLastSignal.size > 5000) {
    for (const [k, ts] of sessionLastSignal) if (now - ts > 300_000) sessionLastSignal.delete(k);
  }
}

/**
 * Analyze the incoming conversation tail for a read-only tool loop. On a hit,
 * cool down the combo's current front model and hand back the remaining list
 * so the cascade naturally serves the next provider. Never returns an empty
 * list: if everyone is cooling down the original order is preserved.
 */
export function applyLoopGuard({ body, settings, models, comboName, log }) {
  const cfg = configFrom(settings);
  const now = Date.now();
  prune(now);
  if (!cfg.enabled || !Array.isArray(models) || models.length <= 1) return models;

  const detected = detectLoopInMessages(body?.messages, cfg);
  if (!detected.loop) return models;

  const sk = sessionKeyFromBody(body);
  const last = sessionLastSignal.get(sk) || 0;
  if (now - last < 60_000) {
    // Same session already rotated within the last minute: don't pile strikes.
    const filtered = models.filter((m) => !isCoolingDown(m, now));
    return filtered.length ? filtered : models;
  }
  sessionLastSignal.set(sk, now);

  const target = models[0];
  const until = now + cfg.cooldownMinutes * 60_000;
  modelCooldown.set(target, Math.max(modelCooldown.get(target) || 0, until));

  const remaining = models.filter((m) => !isCoolingDown(m, now));
  const result = remaining.length ? remaining : models;
  try {
    log?.info?.(
      "LOOPGUARD",
      `loop signal in combo "${comboName}" -> cooling "${target}" for ${cfg.cooldownMinutes}m (${detected.detail ? JSON.stringify(detected.detail) : "no detail"}); ${result.length}/${models.length} models remain`
    );
  } catch {}
  return result;
}
