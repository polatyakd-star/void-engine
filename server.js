import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
loadDotEnv(path.join(__dirname, ".env"));

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const SUPER =
  "eyJvcyI6IldpbmRvd3MiLCJicm93c2VyIjoiQ2hyb21lIiwiZGV2aWNlIjoiIiwic3lzdGVtX2xvY2FsZSI6InRyIiwiYnJvd3Nlcl91c2VyX2FnZW50IjoiTW96aWxsYS81LjAgKFdpbmRvd3MgTlQgMTAuMDsgV2luNjQ7IHg2NCkgQXBwbGVXZWJLaXQvNTM3LjM2IChLSFRNTCwgbGlrZSBHZWNrbykgQ2hyb21lLzEyNi4wLjAuMCBTYWZhcmkvNTM3LjM2IiwiYnJvd3Nlcl92ZXJzaW9uIjoiMTI2LjAuMC4wIiwib3NfdmVyc2lvbiI6IjEwIiwicmVsZWFzZV9jaGFubmVsIjoic3RhYmxlIiwiY2xpZW50X2J1aWxkX251bWJlciI6NTk1ODk3fQ==";
const VERSION = "render-1.0";
const PANEL_KEY = String(process.env.PANEL_KEY || "").trim();
const PORT = Number(process.env.PORT || 10000);
const BIND = process.env.HOST || "0.0.0.0";
const STATE = path.join(__dirname, "state.json");
const MIN_DELAY = 1200;
const AUTH_STRIKES = 3;

function loadDotEnv(file) {
  try {
    const raw = fs.readFileSync(file, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const s = line.trim();
      if (!s || s.startsWith("#")) continue;
      const i = s.indexOf("=");
      if (i < 1) continue;
      const k = s.slice(0, i).trim();
      let v = s.slice(i + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (!(k in process.env)) process.env[k] = v;
    }
  } catch {}
}

function parseTokens(raw) {
  if (Array.isArray(raw)) raw = raw.join("\n");
  const out = [];
  const seen = new Set();
  for (const part of String(raw || "").split(/[\s,;]+/)) {
    const t = part.trim().replace(/^['"]|['"]$/g, "");
    if (!t || t.startsWith("#") || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

function parseIds(raw) {
  return [...new Set(String(raw || "").match(/\d{5,}/g) || [])];
}

function linesOf(raw) {
  return String(raw || "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseMentions(raw) {
  const s = String(raw || "");
  const out = [];
  const seen = new Set();
  const add = (x) => {
    if (!x || seen.has(x)) return;
    seen.add(x);
    out.push(x);
  };
  if (/@everyone/i.test(s)) add("@everyone");
  if (/@here/i.test(s)) add("@here");
  const re = /<@&(\d{5,})>|role:(\d{5,})|<@!?(\d{5,})>|(\d{5,})/gi;
  let m;
  while ((m = re.exec(s))) {
    if (m[1] || m[2]) add("role:" + (m[1] || m[2]));
    else add(m[3] || m[4]);
  }
  return out;
}

function formatMention(x) {
  if (x === "@everyone" || x === "@here") return x;
  if (String(x).startsWith("role:")) return "<@&" + String(x).slice(5) + ">";
  return "<@" + x + ">";
}

function mentionMode(v) {
  const s = String(v || "all").toLowerCase();
  if (s === "rotate" || s === "don") return "rotate";
  return s === "pack" || s === "paket" ? "pack" : "all";
}

function rand5() {
  return String(10000 + Math.floor(Math.random() * 90000));
}

function floorDelay(ms) {
  const n = Math.max(0, Number(ms) || 0);
  return Math.max(MIN_DELAY, n);
}

function waveSize() {
  return 1;
}

async function discord(token, p, body) {
  const res = await fetch("https://discord.com/api/v9" + p, {
    method: body ? "POST" : "GET",
    headers: {
      Authorization: token,
      "Content-Type": "application/json",
      "User-Agent": UA,
      "X-Super-Properties": SUPER,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  let retry = 0;
  if (res.status === 429) {
    retry = Number(parsed && parsed.retry_after);
    if (!Number.isFinite(retry) || retry <= 0) retry = Number(res.headers.get("retry-after")) || 1;
    if (retry > 30) retry = retry / 1000;
    retry = Math.max(0.8, Math.min(20, retry));
  }
  return {
    status: res.status,
    json: parsed,
    retry,
    global: !!(parsed && parsed.global),
    scope: res.headers.get("x-ratelimit-scope") || "",
  };
}

function jobFrom(body, prev) {
  const channel = parseIds(body.channel || body.channels || (prev && prev.channel) || "");
  const messages = linesOf(
    body.message != null ? body.message : body.messages || (prev && prev.messages && prev.messages.join("\n")) || ""
  );
  return {
    channel,
    channelText: String(body.channel || (prev && prev.channelText) || ""),
    messages,
    mentions: body.mentions != null ? parseMentions(body.mentions) : (prev && prev.mentions) || [],
    mentionsText: body.mentions != null ? String(body.mentions) : (prev && prev.mentionsText) || "",
    mentionMode: mentionMode(body.mention_mode || (prev && prev.mentionMode)),
    mentionPack: Math.max(1, Math.min(10, Number(body.mention_pack || (prev && prev.mentionPack) || 5))),
    suffix: body.suffix != null ? !!body.suffix : prev ? prev.suffix !== false : true,
    mode: String(body.mode || (prev && prev.mode) || "channel").toLowerCase() === "dm" ? "dm" : "channel",
    delayMs: floorDelay(body.delay_ms != null ? body.delay_ms : prev && prev.delayMs),
    threads: waveSize(body.threads != null ? body.threads : prev && prev.threads),
    webhook: String(body.webhook != null ? body.webhook : (prev && prev.webhook) || "").trim(),
    smart: !!(body.smart != null ? body.smart : prev && prev.smart),
    maxRatePct: Number(body.max_rate_pct || (prev && prev.maxRatePct) || 25) || 25,
  };
}

const pump = { slice: null, timer: null, busy: false };
let hubJob = null;

function persist() {
  try {
    fs.writeFileSync(STATE, JSON.stringify({ job: hubJob }));
  } catch {}
}

function restore() {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE, "utf8"));
    hubJob = raw.job || null;
    if (hubJob && hubJob.running && !hubJob.paused) loadPump(hubJob);
  } catch {}
}

function wrapTokens(tokens, old) {
  const map = new Map((old || []).map((t) => [t.token, t]));
  return tokens.map((token) => {
    const was = map.get(token);
    return was || { token, dead: false, rlUntil: 0, dm: "", strikes: 0 };
  });
}

function content(s) {
  const line = s.messages[s.msgI % s.messages.length] || ".";
  s.msgI++;
  let text = line;
  if (s.suffix !== false) text += " ! " + rand5();
  const ids = s.mentions || [];
  if (ids.length) {
    if (s.mentionMode === "all") text += " " + ids.map(formatMention).join(" ");
    else {
      const n = s.mentionMode === "rotate" ? 1 : Math.min(s.mentionPack || 5, ids.length);
      const pick = [];
      for (let k = 0; k < n; k++) pick.push(formatMention(ids[(s.mentionI + k) % ids.length]));
      s.mentionI = (s.mentionI + n) % ids.length;
      text += " " + pick.join(" ");
    }
  }
  return text.replace(/\s+/g, " ").trim().slice(0, 2000);
}

function strikeAuth(s, tok, status) {
  tok.strikes = (tok.strikes || 0) + 1;
  const wait = tok.strikes === 1 ? 25000 : tok.strikes === 2 ? 90000 : 180000;
  tok.rlUntil = Date.now() + wait;
  s.lastError = status + " strike " + tok.strikes + "/" + AUTH_STRIKES;
  if (tok.strikes >= AUTH_STRIKES) {
    tok.dead = true;
    s.dead++;
    s.lastError = status + " dead";
  }
}

async function send(s, tok) {
  let channel = s.channel[s.targetI % s.channel.length];
  s.targetI++;
  if (s.mode === "dm") {
    if (!tok.dm) {
      const opened = await discord(tok.token, "/users/@me/channels", { recipient_id: channel });
      if (opened.status === 429) {
        tok.rlUntil = Date.now() + opened.retry * 1000;
        s.rate++;
        s.lastError = "429 " + opened.retry;
        return;
      }
      if (opened.status === 401 || opened.status === 403) {
        strikeAuth(s, tok, opened.status);
        return;
      }
      if (!opened.json || !opened.json.id) {
        s.fail++;
        tok.rlUntil = Date.now() + 4000;
        s.lastError = "dm " + opened.status;
        return;
      }
      tok.dm = opened.json.id;
      tok.strikes = 0;
    }
    channel = tok.dm;
  }
  const text = content(s);
  const r = await discord(tok.token, "/channels/" + channel + "/messages", {
    content: text,
  });
  if (r.status === 200 || r.status === 201) {
    s.ok++;
    tok.strikes = 0;
    tok.rlUntil = Date.now() + Math.max(MIN_DELAY, s.delayMs || MIN_DELAY);
    s.lastOk = text.slice(0, 140);
    s.lastError = "";
    return;
  }
  if (r.status === 429) {
    const wait = (r.global || /shared/i.test(r.scope) ? Math.max(r.retry, 1.2) : r.retry) * 1000;
    tok.rlUntil = Date.now() + wait;
    s.rate++;
    s.lastError = (r.global ? "429 global " : /shared/i.test(r.scope) ? "429 shared " : "429 ") + r.retry;
    if (r.global || /shared/i.test(r.scope)) {
      for (const t of s.tokens) t.rlUntil = Math.max(t.rlUntil || 0, Date.now() + wait);
    }
    return;
  }
  if (r.status === 401 || r.status === 403) {
    strikeAuth(s, tok, r.status);
    return;
  }
  s.fail++;
  tok.rlUntil = Date.now() + 2500;
  s.lastError = String(r.status);
}

async function wave(s) {
  const now = Date.now();
  const ready = (s.tokens || []).filter((t) => !t.dead && (t.rlUntil || 0) <= now);
  if (!ready.length || !(s.channel || []).length || !(s.messages || []).length) {
    const waiting = (s.tokens || []).filter((t) => !t.dead && (t.rlUntil || 0) > now);
    if (!waiting.length) return Date.now() + 800;
    return Math.min(...waiting.map((t) => t.rlUntil));
  }
  await send(s, ready[0]);
  return Date.now() + Math.max(MIN_DELAY, s.delayMs || MIN_DELAY);
}

function arm(ms) {
  if (pump.timer) clearTimeout(pump.timer);
  pump.timer = setTimeout(runPump, Math.max(80, ms));
}

async function runPump() {
  const s = pump.slice;
  if (!s || !s.running || s.paused) return;
  if (pump.busy) {
    arm(200);
    return;
  }
  pump.busy = true;
  try {
    const next = await wave(s);
    if (s.running && !s.paused) arm(Math.max(200, next - Date.now()));
  } catch (e) {
    s.lastError = String(e && e.message ? e.message : e).slice(0, 120);
    if (s.running) arm(800);
  } finally {
    pump.busy = false;
  }
}

function loadPump(job) {
  const prev = pump.slice || {};
  const tokens = wrapTokens(job.tokens || [], prev.tokens || []);
  const s = {
    tokens,
    channel: job.channel || [],
    messages: job.messages || [],
    mentions: job.mentions || [],
    mentionMode: job.mentionMode || "all",
    mentionPack: job.mentionPack || 5,
    mentionI: prev.mentionI || 0,
    suffix: job.suffix !== false,
    mode: job.mode || "channel",
    delayMs: floorDelay(job.delayMs),
    running: !!job.running,
    paused: !!job.paused,
    msgI: prev.msgI || 0,
    targetI: prev.targetI || 0,
    ok: prev.ok || 0,
    fail: prev.fail || 0,
    rate: prev.rate || 0,
    dead: tokens.filter((t) => t.dead).length,
    lastOk: prev.lastOk || "",
    lastError: "",
  };
  pump.slice = s;
  if (s.running && !s.paused && s.tokens.length) arm(120);
  else if (pump.timer) {
    clearTimeout(pump.timer);
    pump.timer = null;
  }
}

function gather() {
  const s = pump.slice;
  if (!s) return { stats: { ok: 0, fail: 0, rate: 0, dead: 0, reset: 0, sent: 0 }, lastOk: "", lastError: "", live: 0 };
  const live = (s.tokens || []).filter((t) => !t.dead).length;
  return {
    stats: {
      ok: s.ok || 0,
      fail: s.fail || 0,
      rate: s.rate || 0,
      dead: s.dead || 0,
      reset: 0,
      sent: s.ok || 0,
    },
    lastOk: s.lastOk || "",
    lastError: s.lastError || "",
    live,
  };
}

function view() {
  const job = hubJob;
  const g = job ? gather() : { stats: { ok: 0, fail: 0, rate: 0, dead: 0, reset: 0, sent: 0 }, lastOk: "", lastError: "", live: 0 };
  return {
    ok: true,
    running: !!(job && job.running),
    paused: !!(job && job.paused),
    resume: !!(job && job.tokens && job.tokens.length && !job.running),
    mode: (job && job.mode) || "channel",
    mention_mode: (job && job.mentionMode) || "all",
    mention_pack: (job && job.mentionPack) || 5,
    suffix: job ? job.suffix !== false : true,
    smart: !!(job && job.smart),
    max_rate_pct: (job && job.maxRatePct) || 25,
    channel: (job && job.channelText) || "",
    messages: (job && job.messages) || [],
    mentions: (job && job.mentionsText) || "",
    webhook: (job && job.webhook) || "",
    tokens: job ? (job.tokens || []).length : 0,
    skip: 0,
    msg_n: job ? (job.messages || []).length : 0,
    delay_ms: (job && job.delayMs) || MIN_DELAY,
    threads: 1,
    heartbeat: Date.now(),
    last_ok: g.lastOk,
    last_error: g.lastError,
    version: VERSION,
    engine: "render",
    stats: g.stats,
  };
}

async function start(body) {
  const prev = hubJob;
  const tokens = parseTokens(body.tokens);
  if (!tokens.length && prev && (prev.tokens || []).length) {
    prev.running = true;
    prev.paused = false;
    hubJob = prev;
    persist();
    loadPump(prev);
    return { ...view(), resume: true };
  }
  const spec = jobFrom(body, prev);
  if (!tokens.length) return { ok: false, error: "token yok" };
  if (!spec.channel.length) return { ok: false, error: "hedef yok" };
  if (!spec.messages.length) return { ok: false, error: "mesaj yok" };
  hubJob = { ...spec, tokens, running: true, paused: false };
  persist();
  pump.slice = null;
  loadPump(hubJob);
  return view();
}

async function patch(body) {
  if (!hubJob) return { ok: false, error: "job yok" };
  const spec = jobFrom(body, hubJob);
  const tokens = parseTokens(body.tokens);
  const job = { ...hubJob, ...spec, running: true, paused: !!hubJob.paused };
  if (tokens.length) job.tokens = tokens;
  if (!job.channel.length) return { ok: false, error: "hedef yok" };
  hubJob = job;
  persist();
  loadPump(job);
  return { ...view(), patched: true };
}

async function stop() {
  const job = hubJob || { tokens: [] };
  job.running = false;
  job.paused = false;
  hubJob = job;
  persist();
  loadPump(job);
  return view();
}

async function pause() {
  if (!hubJob) return { ok: false, error: "job yok" };
  hubJob.paused = !hubJob.paused;
  hubJob.running = true;
  persist();
  loadPump(hubJob);
  return view();
}

async function addTokens(body) {
  if (!hubJob) return { ok: false, error: "job yok" };
  const add = parseTokens(body.add || body.tokens);
  const seen = new Set(hubJob.tokens || []);
  if (!hubJob.tokens) hubJob.tokens = [];
  for (const t of add) if (!seen.has(t)) hubJob.tokens.push(t);
  persist();
  if (hubJob.running) loadPump(hubJob);
  return view();
}

async function check(body) {
  const tokens = parseTokens(body.tokens);
  const rows = [];
  let valid = 0;
  let dead = 0;
  let rate = 0;
  for (const token of tokens) {
    try {
      const r = await discord(token, "/users/@me");
      if (r.status === 200 && r.json && r.json.id) {
        valid++;
        rows.push({ state: "valid", token: r.json.username || r.json.id, raw: token, detail: r.json.id });
      } else if (r.status === 429) {
        rate++;
        rows.push({ state: "429", token: token.slice(0, 8), raw: token, detail: "rate" });
      } else if (r.status === 401 || r.status === 403) {
        dead++;
        rows.push({ state: "dead", token: token.slice(0, 8), raw: "", detail: String(r.status) });
      } else {
        rows.push({ state: "fail", token: token.slice(0, 8), raw: token, detail: String(r.status) });
      }
    } catch {
      rows.push({ state: "fail", token: token.slice(0, 8), raw: token, detail: "net" });
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  return { ok: true, valid, dead, locked: 0, rate, rows };
}

async function hook(body) {
  const url = String((body && body.webhook) || "").trim();
  if (!url) return { ok: false, error: "webhook yok" };
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: "void render webhook ok" }),
  });
  if (res.status !== 204 && res.status !== 200) return { ok: false, error: "webhook " + res.status };
  if (hubJob) {
    hubJob.webhook = url;
    persist();
  }
  return { ok: true };
}

function sendJson(res, data, status = 200) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type, x-panel-key",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve({});
      }
    });
  });
}

function authorized(req) {
  if (!PANEL_KEY) return false;
  const hdr = String(req.headers["x-panel-key"] || "").trim();
  const q = new URL(req.url || "/", "http://localhost").searchParams.get("k") || "";
  return hdr === PANEL_KEY || q === PANEL_KEY;
}

function keepUrl() {
  const env = String(process.env.KEEP_URL || process.env.RENDER_EXTERNAL_URL || "").trim();
  return env.replace(/\/+$/, "");
}

function keepAlive() {
  const u = keepUrl();
  if (!u) return;
  fetch(u + "/health").catch(() => {});
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", "http://localhost");
    if (req.method === "OPTIONS") return sendJson(res, { ok: true });
    if (url.pathname === "/health" || url.pathname === "/v1/health") {
      return sendJson(res, { ok: true, version: VERSION, engine: "render" });
    }
    if (!authorized(req)) return sendJson(res, { ok: false, error: "unauthorized" }, 401);
    const body = req.method === "GET" ? {} : await readBody(req);
    if (url.pathname === "/v1/start") return sendJson(res, await start(body));
    if (url.pathname === "/v1/stop") return sendJson(res, await stop());
    if (url.pathname === "/v1/pause") return sendJson(res, await pause());
    if (url.pathname === "/v1/patch") return sendJson(res, await patch(body));
    if (url.pathname === "/v1/status") return sendJson(res, view());
    if (url.pathname === "/v1/tokens") return sendJson(res, await addTokens(body));
    if (url.pathname === "/v1/check") return sendJson(res, await check(body));
    if (url.pathname === "/v1/hook") return sendJson(res, await hook(body));
    if (url.pathname === "/v1/notify") return sendJson(res, await hook(body));
    return sendJson(res, { ok: false, error: "not found" }, 404);
  } catch (e) {
    return sendJson(res, { ok: false, error: String(e && e.message ? e.message : e).slice(0, 180) });
  }
});

restore();
setInterval(keepAlive, 4 * 60 * 1000);
setTimeout(keepAlive, 8000);

if (!PANEL_KEY) {
  console.error("PANEL_KEY yok.");
  process.exit(1);
}

server.listen(PORT, BIND, () => {
  console.log("void render " + VERSION + "  http://" + BIND + ":" + PORT);
});
