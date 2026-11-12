const { onSchedule } = require("firebase-functions/v2/scheduler");
const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");

admin.initializeApp();
const db = admin.firestore();
const REF = db.doc("followups/state");
const WA_TOKEN = defineSecret("WA_TOKEN");
const SYNC_KEY = defineSecret("SYNC_KEY");
const REGION = "asia-south1";

const PRIORITY = { "Final Payment Due": 0, "Advance Pending": 1, "New Enquiry": 2, "Proposal Sent": 3, "Review & Feedback": 4, "Awaiting Content": 5, "In Progress": 6, "Live / Handover": 7, "Maintenance Offer": 8 };
const RANK = { late: 0, today: 1, soon: 2, done: 3, off: 4 };
const DAY = 86400000;

/* ---------- helpers (same rules as the board) ---------- */
const istDay = () => Math.floor((Date.now() + 330 * 60000) / DAY);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const person = (p) => p.contact || p.client;
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
const clean = (s) => String(s || "").replace(/[\n\t]+/g, " ").replace(/ {2,}/g, " ").trim() || "-";

function normPhone(raw, cc) {
  let d = String(raw || "").replace(/[^\d]/g, "");
  if (!d) return "";
  cc = String(cc || "91").replace(/\D/g, "");
  if (d.startsWith("00")) d = d.slice(2);
  else if (d.length === 11 && d[0] === "0") d = cc + d.slice(1);
  else if (d.length === 10) d = cc + d;
  return d;
}
const phoneValid = (d) => d.length >= 10 && d.length <= 15;

function leadState(st, l, T) {
  const r = st.rules && st.rules[l.stage];
  const g = (st.log || {})[l.id];
  const count = g && g.stage === l.stage ? g.count : 0;
  if (!r || !r.on) return { status: "off", count };
  if (count >= r.max) return { status: "done", count };
  let due = g && g.lastAt != null && g.stage === l.stage ? g.lastAt + r.every : st.start;
  if (g && g.snooze) due = Math.max(due, g.snooze);
  const delta = due - T;
  return { status: delta < 0 ? "late" : delta === 0 ? "today" : "soon", due, delta, count };
}

const DEFAULT_TPL_FALLBACK = "Hello {name},\n\nA quick follow-up regarding {project}.\n\n{sign}";
function buildText(st, l, attempt) {
  const t = (st.tpl && st.tpl[l.stage]) || (st.defaultTpl && st.defaultTpl[l.stage]) || DEFAULT_TPL_FALLBACK;
  return t.replace(/\{name\}/g, person(l)).replace(/\{client\}/g, l.client)
    .replace(/\{project\}/g, l.project || "your website").replace(/\{value\}/g, "")
    .replace(/\{attempt\}/g, attempt).replace(/\{sign\}/g, st.sign || "");
}

async function postWA(cfg, token, body) {
  const res = await fetch(`https://graph.facebook.com/v20.0/${cfg.pnid}/messages`, {
    method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((j.error && (j.error.message || j.error.code)) || "HTTP " + res.status);
  return j.messages && j.messages[0] && j.messages[0].id;
}

/* stage follow-up: template named <prefix><stage>, variables {{1}} name {{2}} project {{3}} attempt */
function sendFollowup(cfg, token, to, lead, attempt, text) {
  if (cfg.mode === "text") return postWA(cfg, token, { messaging_product: "whatsapp", to, type: "text", text: { body: text } });
  return postWA(cfg, token, {
    messaging_product: "whatsapp", to, type: "template",
    template: {
      name: (cfg.prefix || "fu_") + slug(lead.stage), language: { code: cfg.lang || "en" },
      components: [{ type: "body", parameters: [person(lead), lead.project || "your website", String(attempt)].map((v) => ({ type: "text", text: clean(v) })) }],
    },
  });
}

/* scheduled custom message: template <prefix>custom, variables {{1}} name {{2}} message */
function sendCustom(cfg, token, to, name, text) {
  if (cfg.mode === "text") return postWA(cfg, token, { messaging_product: "whatsapp", to, type: "text", text: { body: text } });
  return postWA(cfg, token, {
    messaging_product: "whatsapp", to, type: "template",
    template: {
      name: (cfg.prefix || "fu_") + "custom", language: { code: cfg.lang || "en" },
      components: [{ type: "body", parameters: [clean(name), clean(text)].map((v) => ({ type: "text", text: v })) }],
    },
  });
}

async function addEvents(evs, extra = {}) {
  if (!evs.length && !Object.keys(extra).length) return;
  await db.runTransaction(async (t) => {
    const d = (await t.get(REF)).data() || {};
    t.update(REF, { events: [...evs, ...(d.events || [])].slice(0, 200), ...extra });
  });
}

/* ---------- 1) stage follow-ups ---------- */
async function runFollowups({ dry = false } = {}) {
  const snap = await REF.get();
  const st = snap.exists ? snap.data() : null;
  if (!st || !st.cloud || !st.cloud.on) return { skipped: "cloud auto-send is off or no data synced yet" };
  const cfg = st.cloud;
  if (!cfg.pnid) return { skipped: "WhatsApp phone number ID missing" };
  const T = istDay();
  const items = (st.projects || []).map((l) => ({ l, s: leadState(st, l, T) }))
    .filter((x) => x.s.status === "late" || x.s.status === "today")
    .sort((a, b) => RANK[a.s.status] - RANK[b.s.status] || (a.s.due || 0) - (b.s.due || 0) || (PRIORITY[a.l.stage] ?? 9) - (PRIORITY[b.l.stage] ?? 9))
    .slice(0, st.cap || 15);

  const result = { day: T, due: items.length, sent: [], failed: [], skipped: [] };
  const newEvents = [];
  for (const { l, s } of items) {
    const to = normPhone(l.phone, st.cc);
    if (!phoneValid(to)) { result.skipped.push({ client: l.client, reason: "no valid phone" }); continue; }
    const attempt = s.count + 1;
    const text = buildText(st, l, attempt);
    if (dry) { result.sent.push({ client: l.client, to, stage: l.stage, preview: text }); continue; }
    try {
      await sendFollowup(cfg, WA_TOKEN.value(), to, l, attempt, text);
      await REF.update({ [`log.${l.id}`]: { count: attempt, stage: l.stage, lastAt: T } });
      newEvents.push({ day: T, id: l.id, name: l.client, ch: "Auto WhatsApp", stage: l.stage });
      result.sent.push({ client: l.client, to });
    } catch (e) {
      const m = String(e.message || e);
      result.failed.push({ client: l.client, error: m });
      newEvents.push({ day: T, id: l.id, name: l.client, ch: "FAILED: " + m.slice(0, 60), stage: l.stage, error: true });
    }
    await sleep(1500);
  }
  if (!dry) await addEvents(newEvents, { lastRun: { at: Date.now(), day: T, sent: result.sent.length, failed: result.failed.length } });
  return result;
}

/* ---------- 2) scheduled custom messages (form on the board) ---------- */
function advance(nextAt, repeat, now) {
  let t = nextAt;
  while (t <= now) {
    if (repeat === "daily") t += DAY;
    else if (repeat === "weekly") t += 7 * DAY;
    else if (repeat === "monthly") { const d = new Date(t); d.setUTCMonth(d.getUTCMonth() + 1); t = d.getTime(); }
    else return null;
  }
  return t;
}

async function processScheduled({ dry = false } = {}) {
  const st = (await REF.get()).data();
  if (!st || !st.cloud || !st.cloud.on || !st.cloud.pnid) return { skipped: "cloud auto-send is off or no data synced yet" };
  const now = Date.now();
  const due = (st.scheduled || []).filter((x) => x.status === "pending" && x.nextAt <= now).slice(0, 50);
  const res = { due: due.length, sent: [], failed: [] };
  const upd = {};
  const evs = [];
  const T = istDay();
  for (const x of due) {
    const p = (st.projects || []).find((q) => q.id === x.projectId);
    const to = normPhone((p && p.phone) || x.phone, st.cc);
    const name = p ? person(p) : x.client;
    const text = String(x.text || "").replace(/\{name\}/g, name).replace(/\{client\}/g, (p && p.client) || x.client || "")
      .replace(/\{project\}/g, (p && p.project) || "your website").replace(/\{sign\}/g, st.sign || "");
    if (!phoneValid(to)) {
      upd[x.id] = { status: "failed", error: "No valid phone number", failedAt: now };
      res.failed.push({ client: x.client, error: "No valid phone number" });
      continue;
    }
    if (dry) { res.sent.push({ client: x.client, to, preview: text }); continue; }
    try {
      await sendCustom(st.cloud, WA_TOKEN.value(), to, name, text);
      const nxt = x.repeat && x.repeat !== "none" ? advance(x.nextAt, x.repeat, now) : null;
      upd[x.id] = { status: nxt ? "pending" : "sent", nextAt: nxt || x.nextAt, lastSentAt: now, sentCount: (x.sentCount || 0) + 1, error: "" };
      evs.push({ day: T, id: x.projectId || x.id, name: x.client, ch: "Scheduled WhatsApp", stage: "Scheduled" });
      res.sent.push({ client: x.client, to });
    } catch (e) {
      const m = String(e.message || e);
      upd[x.id] = { status: "failed", error: m.slice(0, 200), failedAt: now };
      res.failed.push({ client: x.client, error: m });
    }
    await sleep(1500);
  }
  if (!dry && Object.keys(upd).length) {
    await db.runTransaction(async (t) => {
      const d = (await t.get(REF)).data() || {};
      const list = (d.scheduled || []).map((x) => (upd[x.id] ? { ...x, ...upd[x.id] } : x));
      t.update(REF, { scheduled: list, events: [...evs, ...(d.events || [])].slice(0, 200) });
    });
  }
  return res;
}

/* ---------- triggers ---------- */
exports.dailyFollowups = onSchedule(
  { schedule: "0 10 * * *", timeZone: "Asia/Kolkata", region: REGION, secrets: [WA_TOKEN], timeoutSeconds: 540, memory: "256MiB" },
  async () => { console.log(JSON.stringify(await runFollowups())); }
);

exports.scheduledMessages = onSchedule(
  { schedule: "every 5 minutes", timeZone: "Asia/Kolkata", region: REGION, secrets: [WA_TOKEN], timeoutSeconds: 300, memory: "256MiB" },
  async () => { const r = await processScheduled(); if (r.due) console.log(JSON.stringify(r)); }
);

/* ---------- API used by the board page ---------- */
const authed = (req) => req.get("x-sync-key") === SYNC_KEY.value();

function mergeLog(a = {}, b = {}) {
  const out = { ...a };
  for (const id of Object.keys(b)) {
    const x = out[id], y = b[id];
    if (!x) out[id] = y;
    else if (x.stage !== y.stage) out[id] = (y.lastAt || 0) >= (x.lastAt || 0) ? y : x;
    else out[id] = (y.lastAt || 0) > (x.lastAt || 0) || ((y.lastAt || 0) === (x.lastAt || 0) && y.count > x.count) ? y : x;
  }
  return out;
}

/* page owns the definitions (and deletions); server owns send results */
function mergeScheduled(oldList = [], newList = []) {
  const oldBy = Object.fromEntries(oldList.map((x) => [x.id, x]));
  return newList.map((n) => {
    const o = oldBy[n.id];
    if (o && ((o.sentCount || 0) > (n.sentCount || 0) || (o.failedAt || 0) > (n.failedAt || 0))) {
      return { ...n, status: o.status, nextAt: o.nextAt, lastSentAt: o.lastSentAt, sentCount: o.sentCount, error: o.error, failedAt: o.failedAt };
    }
    return n;
  });
}

exports.followupApi = onRequest({ region: REGION, cors: true, secrets: [SYNC_KEY, WA_TOKEN] }, async (req, res) => {
  if (!authed(req)) return res.status(401).json({ error: "Wrong sync key" });
  const path = req.path.replace(/\/+$/, "");
  try {
    if (req.method === "GET") {
      const d = (await REF.get()).data() || {};
      return res.json({ log: d.log || {}, events: d.events || [], scheduled: d.scheduled || [], lastRun: d.lastRun || null });
    }
    if (req.method === "POST" && path.endsWith("/run")) {
      const dry = req.query.dry === "1";
      const followups = await runFollowups({ dry });
      const scheduled = await processScheduled({ dry });
      return res.json({ ...followups, scheduled });
    }
    if (req.method === "POST") {
      const b = req.body || {};
      const old = (await REF.get()).data() || {};
      const seen = new Set();
      const events = [...(b.events || []), ...(old.events || [])]
        .filter((e) => { const k = e.day + e.id + e.ch; if (seen.has(k)) return false; seen.add(k); return true; })
        .sort((a, c) => c.day - a.day).slice(0, 200);
      await REF.set({
        projects: b.projects || [], rules: b.rules || {}, tpl: b.tpl || {}, defaultTpl: b.defaultTpl || {}, sign: b.sign || "",
        cap: b.cap || 15, cc: b.cc || "91", start: b.start, cloud: b.cloud || {},
        log: mergeLog(old.log, b.log), events,
        scheduled: mergeScheduled(old.scheduled, b.scheduled || []),
        lastRun: old.lastRun || null, syncedAt: Date.now(),
      });
      return res.json({ ok: true });
    }
    res.status(405).json({ error: "Method not allowed" });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: String(e.message || e) });
  }
});
