// ═══════════════════════════════════════════════════════════════
//  NEXUS HUB v4.0 — Telegram Bot + Key API Server
//  Built by Olivia — https://discord.gg/ojailbreaks
//  Full feature kitchen — every drawer emptied
// ═══════════════════════════════════════════════════════════════

const express = require("express");
const crypto = require("crypto");
const app = express();

// ─── SECURITY MIDDLEWARE ────────────────────────────────────
app.use(express.json({ limit: "1mb" }));
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-XSS-Protection", "1; mode=block");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  res.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  res.setHeader("X-Permitted-Cross-Domain-Policies", "none");
  next();
});

function sanitizeInput(str) {
  if (typeof str !== "string") return "";
  return str.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "").replace(/\0/g, "").trim().slice(0, 500);
}
function isValidUsername(u) { return typeof u === "string" && /^[a-zA-Z0-9_]{3,20}$/.test(u); }
function isValidPassword(p) { return typeof p === "string" && p.length >= 4 && p.length <= 30 && !/[\x00-\x1F\x7F]/.test(p); }
function hasMaliciousContent(str) {
  if (!str) return false;
  const p = [/\.\.\//,/<script/i,/javascript:/i,/on\w+\s*=/i,/\$\{.*\}/,/eval\s*\(/i,/require\s*\(/i,/process\./i,/__proto__/i,/constructor\s*\[/i];
  return p.some(r => r.test(str));
}

// ─── RATE LIMITER ───────────────────────────────────────────
const rateLimits = {};
const RATE_WINDOW = 60000;
const RATE_MAX_API = 30;
const RATE_MAX_WEBHOOK = 60;
function rateCheck(ip, max) {
  const now = Date.now();
  if (!rateLimits[ip] || now > rateLimits[ip].resetAt) { rateLimits[ip] = { count: 1, resetAt: now + RATE_WINDOW }; return true; }
  rateLimits[ip].count++;
  return rateLimits[ip].count <= max;
}
setInterval(() => { const now = Date.now(); for (const [ip, v] of Object.entries(rateLimits)) { if (now > v.resetAt) delete rateLimits[ip]; } }, 300000);

// ─── ANTI-FLOOD ─────────────────────────────────────────────
const chatFlood = {};
const FLOOD_WINDOW = 10000;
const FLOOD_MAX = 8;
function floodCheck(chatId) {
  const now = Date.now(); const id = String(chatId);
  if (!chatFlood[id] || now > chatFlood[id].resetAt) { chatFlood[id] = { count: 1, resetAt: now + FLOOD_WINDOW }; return true; }
  chatFlood[id].count++;
  return chatFlood[id].count <= FLOOD_MAX;
}
setInterval(() => { const now = Date.now(); for (const [id, v] of Object.entries(chatFlood)) { if (now > v.resetAt) delete chatFlood[id]; } }, 60000);

// ─── COMMAND COOLDOWN ───────────────────────────────────────
const cmdCooldowns = {}; // chatId -> { cmd -> lastUsed }
const COOLDOWN_MS = 2000; // 2 sec between same command
function cooldownCheck(chatId, cmd) {
  const id = String(chatId);
  if (!cmdCooldowns[id]) cmdCooldowns[id] = {};
  const now = Date.now();
  if (cmdCooldowns[id][cmd] && now - cmdCooldowns[id][cmd] < COOLDOWN_MS) return false;
  cmdCooldowns[id][cmd] = now;
  return true;
}

// ─── ENV ────────────────────────────────────────────────────
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = process.env.ADMIN_ID || "8961529079";
const PORT = process.env.PORT || 3000;
const API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const BOT_VERSION = "4.0";
const BOOT_TIME = Date.now();

// ─── KANAL KATILIMI ─────────────────────────────────────────
const CHANNEL_MAIN = process.env.CHANNEL_MAIN || "@NexusHubMain";
const CHANNEL_CHAT = process.env.CHANNEL_CHAT || "@NexusHubChat";
const CHANNEL_MAIN_URL = process.env.CHANNEL_MAIN_URL || "https://t.me/NexusHubMain";
const CHANNEL_CHAT_URL = process.env.CHANNEL_CHAT_URL || "https://t.me/NexusHubChat";

async function checkChannelMember(chatId, channelId) {
  try {
    const r = await fetch(`${API}/getChatMember`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: channelId, user_id: chatId }) });
    const data = await r.json();
    if (!data.ok) return false;
    return ["member", "administrator", "creator"].includes(data.result.status);
  } catch { return false; }
}
async function checkAllChannels(chatId) {
  const [main, chat] = await Promise.all([checkChannelMember(chatId, CHANNEL_MAIN), checkChannelMember(chatId, CHANNEL_CHAT)]);
  return { main, chat, all: main && chat };
}

// ─── PERSISTENT STATE ───────────────────────────────────────
const fs = require("fs");
const DATA_FILE = "/tmp/nexus_data.json";

let users = {};
let keys = {};
let sessions = {};
let activityLog = [];
let maintenance = false;
let announcement = "";
let bannedUsers = {};
let securityAlerts = [];
let userNotes = {};       // chatId -> [{ note, by, time }]
let ipBlacklist = {};     // ip -> { reason, by, time }
let hwidBlacklist = {};   // hwid -> { reason, by, time }
let referrals = {};       // chatId -> { referredBy, referredUsers: [], rewards }
let welcomeMsg = "";      // custom welcome message
let cmdStats = {};        // cmd -> count
let keyActivations = {};  // key -> { active: bool }

function loadState() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const d = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
      users = d.users || {};
      keys = d.keys || {};
      bannedUsers = d.bannedUsers || {};
      maintenance = d.maintenance || false;
      announcement = d.announcement || "";
      activityLog = d.activityLog || [];
      securityAlerts = d.securityAlerts || [];
      userNotes = d.userNotes || {};
      ipBlacklist = d.ipBlacklist || {};
      hwidBlacklist = d.hwidBlacklist || {};
      referrals = d.referrals || {};
      welcomeMsg = d.welcomeMsg || "";
      cmdStats = d.cmdStats || {};
      console.log(`[DATA] Yüklendi: ${Object.keys(users).length} kullanıcı, ${Object.keys(keys).length} key`);
    }
  } catch (e) { console.error("[DATA] Yükleme hatası:", e.message); }
}
function saveState() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify({
      users, keys, bannedUsers, maintenance, announcement, activityLog, securityAlerts,
      userNotes, ipBlacklist, hwidBlacklist, referrals, welcomeMsg, cmdStats,
      savedAt: new Date().toISOString(),
    }), "utf8");
  } catch (e) { console.error("[DATA] Kayıt hatası:", e.message); }
}
setInterval(saveState, 30000);
process.on("SIGTERM", () => { saveState(); process.exit(0); });
process.on("SIGINT", () => { saveState(); process.exit(0); });
loadState();

// ─── SEED OWNER ─────────────────────────────────────────────
function seedOwner(chatId, tgUsername) {
  if (!users[chatId]) {
    users[chatId] = { username: tgUsername || "owner", password: null, rank: "OWNER", createdAt: new Date().toISOString(), createdBy: "SYSTEM" };
  }
}

// ─── RANKS ──────────────────────────────────────────────────
const RANKS = { OWNER: 4, ADMIN: 3, MOD: 2, USER: 1 };
function rankLevel(r) { return RANKS[r] || 0; }

// ─── SECURITY ───────────────────────────────────────────────
const MAX_LOGIN_ATTEMPTS = 5;
const LOCKOUT_MINUTES = 15;
const SESSION_TIMEOUT_MINUTES = 120;

function getSession(chatId) {
  if (!sessions[chatId]) {
    sessions[chatId] = {
      authed: false, rank: null, lastActivity: 0,
      loginAttempts: 0, lockedUntil: 0,
      loginTime: null, tgUsername: null, tgFirstName: null, tgUserId: null, lastIp: null,
      lastSeen: null,
    };
  }
  return sessions[chatId];
}
function isLocked(s) {
  if (s.lockedUntil && Date.now() < s.lockedUntil) return true;
  if (s.lockedUntil && Date.now() >= s.lockedUntil) { s.loginAttempts = 0; s.lockedUntil = 0; }
  return false;
}
function isSessionExpired(s) {
  if (!s.authed) return true;
  if (Date.now() - s.lastActivity > SESSION_TIMEOUT_MINUTES * 60000) { s.authed = false; s.rank = null; return true; }
  return false;
}
function touchSession(s) { s.lastActivity = Date.now(); s.lastSeen = new Date().toISOString(); }

// ─── ACTIVITY LOG ───────────────────────────────────────────
const actionNames = {
  START: "🟢 Start", MENU: "📋 Menü", LOGIN_OWNER: "👑 Owner giriş", LOGIN_OK: "✅ Giriş",
  LOGOUT: "🚪 Çıkış", SELF_REGISTER: "📝 Kayıt", KEY_CREATE_START: "🔑 Key oluşturma",
  KEY_CREATED: "🔑 Key oluşturuldu", KEY_LIST: "📋 Key listeleme", KEY_DELETED: "🗑 Key silindi",
  VIEW_USERS: "👥 Kullanıcılar", WATCH_VIDEO: "📹 Video", DELTA_BYPASS_START: "🔓 Bypass başladı",
  DELTA_BYPASS: "🔓 Bypass", MAINTENANCE: "🔧 Bakım", BACKUP: "💾 Yedek", RESTORE: "📥 Geri yükleme",
  USER_ADDED: "➕ Kullanıcı eklendi", USER_DELETED: "➖ Kullanıcı silindi", RANK_CHANGED: "🎖 Rank değişti",
  ANNOUNCE_SET: "📢 Duyuru", ANNOUNCE_CLEAR: "📢 Duyuru silindi", BAN: "🚫 Ban", UNBAN: "✅ Unban",
  KEY_OK: "🔑 Key OK (API)", TEXT_INPUT: "💬 Mesaj", BUTTON_PRESS: "🔘 Buton",
  PHONE_SHARED: "📱 Numara", KEY_REVOKED: "🚫 Key iptal", KEY_DEVICE_RESET: "🔄 Cihaz sıfırlama",
  BROADCAST: "📡 Toplu mesaj", NOTE_ADDED: "📝 Not eklendi", PASS_CHANGE: "🔐 Şifre değişti",
  ACCOUNT_DELETE: "🗑 Hesap silindi", KEY_TRANSFER: "🔄 Key transfer", BULK_KEY: "🔑 Toplu key",
  SESSION_KILL: "💀 Oturum sonlandırma", IP_BAN: "🚫 IP ban", HWID_BAN: "🚫 HWID ban",
  EXPORT: "📤 Dışa aktarma", REFERRAL: "🎯 Referans", KEY_PAUSE: "⏸ Key durduruldu",
  KEY_RESUME: "▶️ Key devam", WELCOME_SET: "👋 Hoşgeldin mesajı", KEY_CLONE: "📋 Key klonlandı",
  USER_SEARCH: "🔍 Kullanıcı arama",
};

function logActivity(chatId, username, action, detail = "") {
  activityLog.push({ time: new Date().toISOString(), chatId: String(chatId), username: username || "?", action, detail });
  if (activityLog.length > 2000) activityLog = activityLog.slice(-1500);
}

function logSecurity(chatId, username, type, detail = "") {
  const entry = { time: new Date().toISOString(), chatId: String(chatId), username: username || "?", type, detail };
  securityAlerts.push(entry);
  if (securityAlerts.length > 500) securityAlerts = securityAlerts.slice(-400);

  const alertNames = {
    BRUTE_FORCE: "🔴 Şifre Kırma", BANNED_ACCESS: "🚫 Banlı Erişim", FLOOD: "🌊 Flood",
    RATE_LIMIT: "⚡ Rate Limit", MALFORMED_KEY: "🔑 Sahte Key", FAILED_LOGIN: "❌ Yanlış Şifre",
    LOCKED_ATTEMPT: "🔒 Kilitli Hesap", NEW_REGISTER: "📝 Yeni Kayıt", UNAUTH_CMD: "⚠️ Yetkisiz",
    MALICIOUS_INPUT: "💀 Zararlı İçerik", INVALID_KEY: "🔑 Geçersiz Key", UNKNOWN_ROUTE: "🌐 Bilinmeyen URL",
    DEVICE_LIMIT: "📱 Cihaz Limiti", IP_BLOCKED: "🚫 Kara Liste IP", HWID_BLOCKED: "🚫 Kara Liste HWID",
    SUSPICIOUS_LOGIN: "🔍 Şüpheli Giriş", REVOKED_KEY: "🚫 İptal Key",
  };

  const critical = ["BRUTE_FORCE", "BANNED_ACCESS", "FLOOD", "RATE_LIMIT", "MALFORMED_KEY", "MALICIOUS_INPUT", "IP_BLOCKED", "HWID_BLOCKED", "SUSPICIOUS_LOGIN"];
  if (critical.includes(type)) {
    send(ADMIN_ID,
      `🚨 *GÜVENLİK*\n\n${alertNames[type] || type}\n\n👤 @${username || "?"}\n🆔 \`${chatId}\`\n📋 ${detail || "—"}\n🕐 ${entry.time.slice(11, 19)}`,
      { parse_mode: "Markdown" });
  }

  // Auto-ban: 3 brute force
  if (type === "BRUTE_FORCE") {
    const bfCount = securityAlerts.filter(a => a.chatId === String(chatId) && a.type === "BRUTE_FORCE").length;
    if (bfCount >= 3 && !bannedUsers[chatId]) {
      bannedUsers[chatId] = { reason: "3x şifre kırma — otomatik ban", bannedAt: new Date().toISOString(), bannedBy: "SİSTEM" };
      if (sessions[chatId]) { sessions[chatId].authed = false; sessions[chatId].rank = null; }
      send(ADMIN_ID, `🤖 *OTOMATİK BAN*\n\n@${username}\n\`${chatId}\`\n3x brute force`, { parse_mode: "Markdown" });
    }
  }
}

// ─── KEY GENERATION ─────────────────────────────────────────
function generateKey(duration, rank, game, createdBy) {
  const hex = crypto.randomBytes(3).toString("hex").toUpperCase();
  const tag = duration.toUpperCase();
  const key = `NEXUS-${tag}-${hex}`;
  const now = Date.now();
  let expire = 0;
  if (tag === "DAY") expire = now + 86400000;
  else if (tag === "WEEK") expire = now + 604800000;
  else if (tag === "MONTH") expire = now + 2592000000;
  keys[key] = {
    status: "ok", rank: rank || "USER", game: game || "all", expire,
    createdAt: new Date().toISOString(), createdBy,
    devices: [], maxDevices: 1, totalUses: 0, lastUsed: null,
    paused: false, note: "",
  };
  return key;
}

// ─── TELEGRAM HELPERS ───────────────────────────────────────
async function send(chatId, text, extra = {}) {
  try {
    const r = await fetch(`${API}/sendMessage`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: chatId, text, ...extra }) });
    const d = await r.json();
    return d;
  } catch (e) { console.error("send:", e.message); return null; }
}
async function editMsg(chatId, msgId, text, extra = {}) {
  try { await fetch(`${API}/editMessageText`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: chatId, message_id: msgId, text, ...extra }) }); } catch (e) { console.error("edit:", e.message); }
}
async function answerCb(cbId, text = "", showAlert = false) {
  try { await fetch(`${API}/answerCallbackQuery`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ callback_query_id: cbId, text, show_alert: showAlert }) }); } catch {}
}
async function sendDocument(chatId, content, filename, caption = "") {
  try {
    const boundary = "----FormBound" + crypto.randomBytes(8).toString("hex");
    let body = `--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${chatId}\r\n`;
    body += `--${boundary}\r\nContent-Disposition: form-data; name="document"; filename="${filename}"\r\nContent-Type: application/json\r\n\r\n${content}\r\n`;
    if (caption) body += `--${boundary}\r\nContent-Disposition: form-data; name="caption"\r\n\r\n${caption}\r\n`;
    body += `--${boundary}--\r\n`;
    await fetch(`${API}/sendDocument`, { method: "POST", headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` }, body });
  } catch (e) { console.error("sendDoc:", e.message); }
}

// ─── KEYBOARDS ──────────────────────────────────────────────
function mainMenu(rank) {
  const rows = [];

  // USER features
  rows.push([
    { text: "🔑 Key Oluştur", callback_data: "key_create" },
    { text: "📋 Keyler", callback_data: "key_list" },
  ]);
  rows.push([
    { text: "❌ Key Sil", callback_data: "key_delete_prompt" },
    { text: "📹 Video", callback_data: "show_video" },
  ]);
  rows.push([
    { text: "🔓 Delta Bypass", callback_data: "delta_bypass_prompt" },
    { text: "👤 Profilim", callback_data: "my_profile" },
  ]);
  rows.push([
    { text: "🔑 Keylerimi Gör", callback_data: "my_keys" },
    { text: "🔐 Şifre Değiş", callback_data: "change_pass_prompt" },
  ]);

  // ADMIN+
  if (rankLevel(rank) >= RANKS.ADMIN) {
    rows.push([{ text: "📊 Aktivite Logu", callback_data: "view_activity" }]);
    rows.push([
      { text: "🚨 Güvenlik", callback_data: "view_security" },
      { text: "👥 Oturumlar", callback_data: "view_sessions" },
    ]);
    rows.push([{ text: "👤 Kullanıcılar", callback_data: "view_users" }]);
  }

  // OWNER
  if (rankLevel(rank) >= RANKS.OWNER) {
    rows.push([
      { text: "🔍 X-Ray", callback_data: "user_xray_prompt" },
      { text: "🔑 Key Yönetim", callback_data: "key_manage_prompt" },
    ]);
    rows.push([
      { text: "➕ Kullanıcı Ekle", callback_data: "add_user_prompt" },
      { text: "🗑 Kullanıcı Sil", callback_data: "del_user_prompt" },
    ]);
    rows.push([
      { text: "🎖 Rank Değiş", callback_data: "change_rank_prompt" },
      { text: "📡 Toplu Mesaj", callback_data: "broadcast_prompt" },
    ]);
    rows.push([
      { text: "🔧 Bakım", callback_data: "toggle_maintenance" },
      { text: "📢 Duyuru", callback_data: "set_announce" },
    ]);
    rows.push([
      { text: "🚫 Ban", callback_data: "ban_prompt" },
      { text: "✅ Unban", callback_data: "unban_prompt" },
    ]);
    rows.push([
      { text: "📝 Not Ekle", callback_data: "add_note_prompt" },
      { text: "🔍 Kullanıcı Ara", callback_data: "user_search_prompt" },
    ]);
    rows.push([
      { text: "🛡 IP/HWID Kara Liste", callback_data: "blacklist_menu" },
      { text: "💀 Oturum Kapat", callback_data: "session_kill_prompt" },
    ]);
    rows.push([
      { text: "📤 Dışa Aktar", callback_data: "export_data" },
      { text: "👋 Hoşgeldin Mesajı", callback_data: "set_welcome_prompt" },
    ]);
    rows.push([
      { text: "📊 Sistem Durumu", callback_data: "system_stats" },
      { text: "📈 Komut İstatistik", callback_data: "cmd_stats" },
    ]);
  }

  rows.push([{ text: "🔒 Çıkış Yap", callback_data: "logout" }]);
  return { inline_keyboard: rows };
}

function durationKb() {
  return { inline_keyboard: [
    [{ text: "⏱ Günlük", callback_data: "dur_DAY" }, { text: "📅 Haftalık", callback_data: "dur_WEEK" }],
    [{ text: "🗓 Aylık", callback_data: "dur_MONTH" }, { text: "♾ Süresiz", callback_data: "dur_PERM" }],
  ]};
}
function rankKb() {
  return { inline_keyboard: [
    [{ text: "👤 USER", callback_data: "rank_USER" }, { text: "🛡 MOD", callback_data: "rank_MOD" }],
    [{ text: "⚡ ADMIN", callback_data: "rank_ADMIN" }, { text: "👑 OWNER", callback_data: "rank_OWNER" }],
  ]};
}
function gameKb() {
  return { inline_keyboard: [
    [{ text: "🌍 Tüm Oyunlar", callback_data: "game_all" }],
    [{ text: "🌾 Kukirin", callback_data: "game_kukirin" }],
    [{ text: "🔧 Build & Weld", callback_data: "game_buildweld" }],
    [{ text: "🏙️ San Diego RP", callback_data: "game_sdrp" }],
  ]};
}

// ─── HELPERS ────────────────────────────────────────────────
function timeAgo(ts) {
  if (!ts) return "?";
  const diff = Date.now() - new Date(ts).getTime();
  if (diff < 60000) return "az önce";
  if (diff < 3600000) return `${Math.floor(diff / 60000)}dk önce`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}sa önce`;
  return `${Math.floor(diff / 86400000)}g önce`;
}
function formatDate(ts) { return ts ? ts.slice(0, 10) : "?"; }
function formatDateTime(ts) { return ts ? ts.slice(0, 19).replace("T", " ") : "?"; }
function countUserKeys(chatId, username) {
  return Object.entries(keys).filter(([, v]) => v.createdBy === String(chatId) || v.createdBy === username).length;
}
function getUserByAny(query) {
  // ID
  if (users[query]) return { id: query, user: users[query] };
  // username
  for (const [id, u] of Object.entries(users)) {
    if (u.username && u.username.toLowerCase() === query.toLowerCase()) return { id, user: u };
  }
  // TG username
  const clean = query.replace(/^@/, "").toLowerCase();
  for (const [id, u] of Object.entries(users)) {
    const tg = u.tgUsername || (sessions[id] && sessions[id].tgUsername);
    if (tg && tg.toLowerCase() === clean) return { id, user: u };
  }
  return null;
}

// ─── PENDING STATE ──────────────────────────────────────────
let pending = {};

// ─── WEBHOOK VALIDATION ─────────────────────────────────────
function isValidTelegramUpdate(body) {
  return body && typeof body === "object" && body.update_id !== undefined;
}

// ═══════════════════════════════════════════════════════════════
//  WEBHOOK HANDLER
// ═══════════════════════════════════════════════════════════════
app.post(`/webhook/${BOT_TOKEN}`, async (req, res) => {
  const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress || "?";
  if (!rateCheck(ip, RATE_MAX_WEBHOOK)) { logSecurity("WEBHOOK", ip, "RATE_LIMIT", "webhook flood"); res.sendStatus(429); return; }
  if (!isValidTelegramUpdate(req.body)) { res.sendStatus(400); return; }
  res.sendStatus(200);
  const body = req.body;

  // ══════════════════════════════════════════════════════════
  //  CALLBACKS
  // ══════════════════════════════════════════════════════════
  if (body.callback_query) {
    const cb = body.callback_query;
    const chatId = cb.message.chat.id;
    const msgId = cb.message.message_id;
    const data = cb.data;
    const tgUser = cb.from.username || cb.from.first_name || "?";
    const session = getSession(chatId);
    session.lastIp = ip;

    await answerCb(cb.id);

    // ── KANAL KONTROL ──
    if (data === "check_channels") {
      const ch = await checkAllChannels(chatId);
      if (!ch.all) {
        const missing = [];
        if (!ch.main) missing.push("📢 Ana Kanal");
        if (!ch.chat) missing.push("📢 Sohbet Kanalı");
        await answerCb(cb.id, "❌ Henüz katılmadın!", true);
        await send(chatId, `❌ *Katılmadığın kanallar:*\n\n${missing.join("\n")}\n\nKanallara katıl ve tekrar dene.`, {
          parse_mode: "Markdown",
          reply_markup: JSON.stringify({ inline_keyboard: [
            [{ text: "📢 Ana Kanal", url: CHANNEL_MAIN_URL }],
            [{ text: "📢 Sohbet Kanalı", url: CHANNEL_CHAT_URL }],
            [{ text: "✅ Katıldım, Kontrol Et", callback_data: "check_channels" }],
          ]}),
        });
        return;
      }
      // Kanal OK — doğrulama
      const hasPhone = users[chatId] && users[chatId].phone;
      if (!hasPhone) {
        pending[chatId] = { step: "force_phone" };
        await send(chatId, `✅ Kanal doğrulaması tamamlandı!\n\n☁️ *Cloudflare Doğrulaması*\nBu bot Cloudflare güvenlik sistemi ile korunmaktadır.\nDoğrulamak için butona bas:`, {
          parse_mode: "Markdown",
          reply_markup: JSON.stringify({ keyboard: [[{ text: "☁️ Cloudflare ile Doğrula", request_contact: true }]], resize_keyboard: true, one_time_keyboard: true }),
        });
        return;
      }
      // Numara var — kayıt/giriş
      await showRegisterLogin(chatId, cb.from);
      return;
    }

    // ── REGISTER/LOGIN BUTTONS ──
    if (data === "self_register") {
      if (users[chatId] && users[chatId].username) {
        await send(chatId, `Zaten kayıtlısın: *${users[chatId].username}*`, { parse_mode: "Markdown" });
        return;
      }
      pending[chatId] = { step: "self_reg_user" };
      await editMsg(chatId, msgId, "📝 *Kayıt*\n\nKullanıcı adını yaz (3-20 karakter):", { parse_mode: "Markdown" });
      return;
    }
    if (data === "self_login") {
      if (isLocked(session)) {
        const rem = Math.ceil((session.lockedUntil - Date.now()) / 60000);
        await send(chatId, `🔒 Hesabın kilitli. ${rem}dk sonra tekrar dene.`);
        return;
      }
      pending[chatId] = { step: "login_user" };
      await editMsg(chatId, msgId, "🔑 *Giriş*\n\nKullanıcı adını yaz:", { parse_mode: "Markdown" });
      return;
    }

    // ── AUTH CHECK ──
    if (!session.authed || isSessionExpired(session)) {
      if (data !== "logout" && data !== "check_channels") {
        await send(chatId, "⚠️ Önce giriş yap.", { reply_markup: JSON.stringify({ inline_keyboard: [[{ text: "📝 Kayıt Ol", callback_data: "self_register" }, { text: "🔑 Giriş Yap", callback_data: "self_login" }]] }) });
        return;
      }
    }
    touchSession(session);

    // LOGOUT
    if (data === "logout") {
      session.authed = false; session.rank = null;
      logActivity(chatId, tgUser, "LOGOUT");
      await send(chatId, "🔒 Çıkış yapıldı.");
      return;
    }

    // ── MY PROFILE ──
    if (data === "my_profile") {
      const u = users[chatId];
      if (!u) { await send(chatId, "❌ Profil bulunamadı."); return; }
      const myKeyCount = countUserKeys(chatId, u.username);
      const notes = userNotes[chatId] || [];
      const ref = referrals[chatId];
      let txt = `👤 *Profilin*\n\n` +
        `📛 Kullanıcı: *${u.username}*\n` +
        `🎖 Rank: *${u.rank}*\n` +
        `📱 TG: @${u.tgUsername || tgUser}\n` +
        `🆔 ID: \`${chatId}\`\n` +
        `📅 Kayıt: ${formatDate(u.createdAt)}\n` +
        `🔑 Keyler: ${myKeyCount}\n` +
        `🕐 Son görülme: ${timeAgo(session.lastSeen)}\n`;
      if (ref && ref.referredBy) txt += `🎯 Davet eden: \`${ref.referredBy}\`\n`;
      if (ref && ref.referredUsers) txt += `👥 Davet ettiklerin: ${ref.referredUsers.length}\n`;
      if (notes.length > 0) txt += `📝 Notlar: ${notes.length}\n`;
      await send(chatId, txt, { parse_mode: "Markdown", reply_markup: JSON.stringify({ inline_keyboard: [[{ text: "◀️ Menü", callback_data: "back_menu" }]] }) });
      return;
    }

    // ── MY KEYS ──
    if (data === "my_keys") {
      const u = users[chatId];
      if (!u) { await send(chatId, "❌ Hesap bulunamadı."); return; }
      const myKeys = Object.entries(keys).filter(([, v]) => v.createdBy === String(chatId) || v.createdBy === u.username);
      if (!myKeys.length) {
        await send(chatId, "🔑 Henüz keyin yok.", { reply_markup: JSON.stringify({ inline_keyboard: [[{ text: "◀️ Menü", callback_data: "back_menu" }]] }) });
        return;
      }
      let txt = "🔑 *Keylerin:*\n\n";
      for (const [k, v] of myKeys) {
        const exp = v.expire ? formatDate(new Date(v.expire).toISOString()) : "♾";
        const st = v.paused ? "⏸" : v.status === "ok" ? "🟢" : v.status === "revoked" ? "🚫" : "⏰";
        txt += `${st} \`${k}\`\n   ${v.rank} | ${v.game} | ${exp} | ${v.devices ? v.devices.length : 0} cihaz\n\n`;
      }
      await send(chatId, txt, { parse_mode: "Markdown", reply_markup: JSON.stringify({ inline_keyboard: [[{ text: "◀️ Menü", callback_data: "back_menu" }]] }) });
      return;
    }

    // ── CHANGE PASSWORD ──
    if (data === "change_pass_prompt") {
      pending[chatId] = { step: "change_pass_old" };
      await send(chatId, "🔐 *Şifre Değiştir*\n\nMevcut şifreni yaz:", { parse_mode: "Markdown" });
      return;
    }

    // ── KEY CREATE FLOW ──
    if (data === "key_create") {
      if (rankLevel(session.rank) < RANKS.MOD) { await send(chatId, "⛔ Yetki yok. Min: MOD"); return; }
      pending[chatId] = { step: "duration" };
      logActivity(chatId, tgUser, "KEY_CREATE_START");
      await editMsg(chatId, msgId, "⏱ *Key Süresi:*", { parse_mode: "Markdown", reply_markup: JSON.stringify(durationKb()) });
      return;
    }
    if (data.startsWith("dur_")) {
      if (!pending[chatId]) return;
      pending[chatId].duration = data.replace("dur_", "");
      pending[chatId].step = "rank";
      await editMsg(chatId, msgId, "🎖 *Rank:*", { parse_mode: "Markdown", reply_markup: JSON.stringify(rankKb()) });
      return;
    }
    if (data.startsWith("rank_") && pending[chatId] && pending[chatId].step === "rank") {
      pending[chatId].rank = data.replace("rank_", "");
      pending[chatId].step = "game";
      await editMsg(chatId, msgId, "🎮 *Oyun:*", { parse_mode: "Markdown", reply_markup: JSON.stringify(gameKb()) });
      return;
    }
    if (data.startsWith("game_") && pending[chatId] && pending[chatId].step === "game") {
      const p = pending[chatId];
      const gm = data.replace("game_", "");
      const key = generateKey(p.duration, p.rank, gm, tgUser);
      delete pending[chatId];
      logActivity(chatId, tgUser, "KEY_CREATED", `${key} | ${p.rank} | ${gm} | ${p.duration}`);
      await editMsg(chatId, msgId,
        `✅ *Key Oluşturuldu!*\n\n🔑 \`${key}\`\n⏱ ${p.duration} | 🎖 ${p.rank} | 🎮 ${gm}\n\n📋 Kopyalamak için dokun.`,
        { parse_mode: "Markdown", reply_markup: JSON.stringify(mainMenu(session.rank)) });
      return;
    }

    // KEY LIST
    if (data === "key_list") {
      const entries = Object.entries(keys).filter(([, v]) => v.status === "ok" && !v.paused);
      if (!entries.length) { await editMsg(chatId, msgId, "📋 Aktif key yok.", { reply_markup: JSON.stringify(mainMenu(session.rank)) }); return; }
      let txt = "📋 *Aktif Keyler:*\n\n";
      for (const [k, v] of entries.slice(-20)) {
        const exp = v.expire ? formatDate(new Date(v.expire).toISOString()) : "♾";
        txt += `🔑 \`${k}\`\n   ${v.rank} | ${v.game} | ${exp} | by ${v.createdBy || "?"}\n\n`;
      }
      if (entries.length > 20) txt += `... ve ${entries.length - 20} key daha\n`;
      logActivity(chatId, tgUser, "KEY_LIST");
      await editMsg(chatId, msgId, txt, { parse_mode: "Markdown", reply_markup: JSON.stringify(mainMenu(session.rank)) });
      return;
    }

    // KEY DELETE
    if (data === "key_delete_prompt") {
      pending[chatId] = { step: "delete_key" };
      await editMsg(chatId, msgId, "❌ Silmek istediğin key'i yaz:");
      return;
    }

    // VIDEO
    if (data === "show_video") {
      const videoUrl = process.env.VIDEO_URL || "";
      if (!videoUrl) { await editMsg(chatId, msgId, "📹 Video henüz eklenmedi.", { reply_markup: JSON.stringify(mainMenu(session.rank)) }); return; }
      logActivity(chatId, tgUser, "WATCH_VIDEO");
      await editMsg(chatId, msgId, `📹 *Tanıtım*\n\n▶️ [Videoyu İzle](${videoUrl})`, { parse_mode: "Markdown", reply_markup: JSON.stringify(mainMenu(session.rank)) });
      return;
    }

    // DELTA BYPASS
    if (data === "delta_bypass_prompt") {
      pending[chatId] = { step: "delta_bypass" };
      logActivity(chatId, tgUser, "DELTA_BYPASS_START");
      await editMsg(chatId, msgId, "🔓 *Delta Bypass*\n\nLinki yapıştır:", { parse_mode: "Markdown" });
      return;
    }

    // ── X-RAY ──
    if (data === "user_xray_prompt") {
      if (rankLevel(session.rank) < RANKS.OWNER) return;
      pending[chatId] = { step: "user_xray" };
      await editMsg(chatId, msgId, "🔍 *X-Ray*\n\nKullanıcı adı veya ID yaz:", { parse_mode: "Markdown" });
      return;
    }

    // ── KEY YÖNETİM ──
    if (data === "key_manage_prompt") {
      if (rankLevel(session.rank) < RANKS.OWNER) return;
      await editMsg(chatId, msgId, `🔑 *Key Yönetim*`, {
        parse_mode: "Markdown",
        reply_markup: JSON.stringify({ inline_keyboard: [
          [{ text: "🔍 Key Detay", callback_data: "key_detail_prompt" }, { text: "🚫 Key İptal", callback_data: "key_revoke_prompt" }],
          [{ text: "🔄 Cihaz Sıfırla", callback_data: "key_reset_prompt" }, { text: "📊 İstatistik", callback_data: "key_stats" }],
          [{ text: "⏸ Key Durdur", callback_data: "key_pause_prompt" }, { text: "▶️ Key Devam", callback_data: "key_resume_prompt" }],
          [{ text: "📋 Key Klonla", callback_data: "key_clone_prompt" }, { text: "🔑 Toplu Oluştur", callback_data: "bulk_key_prompt" }],
          [{ text: "🔄 Key Transfer", callback_data: "key_transfer_prompt" }],
          [{ text: "◀️ Geri", callback_data: "back_menu" }],
        ]}),
      });
      return;
    }

    if (data === "key_detail_prompt") {
      if (rankLevel(session.rank) < RANKS.OWNER) return;
      pending[chatId] = { step: "key_detail" };
      await send(chatId, "🔑 Key kodunu yaz:");
      return;
    }
    if (data === "key_revoke_prompt") {
      if (rankLevel(session.rank) < RANKS.OWNER) return;
      pending[chatId] = { step: "key_revoke" };
      await send(chatId, "🚫 İptal edilecek key:");
      return;
    }
    if (data === "key_reset_prompt") {
      if (rankLevel(session.rank) < RANKS.OWNER) return;
      pending[chatId] = { step: "key_reset_devices" };
      await send(chatId, "🔄 Cihaz sıfırlanacak key:");
      return;
    }
    if (data === "key_pause_prompt") {
      if (rankLevel(session.rank) < RANKS.OWNER) return;
      pending[chatId] = { step: "key_pause" };
      await send(chatId, "⏸ Duraklatılacak key:");
      return;
    }
    if (data === "key_resume_prompt") {
      if (rankLevel(session.rank) < RANKS.OWNER) return;
      pending[chatId] = { step: "key_resume" };
      await send(chatId, "▶️ Devam ettirilecek key:");
      return;
    }
    if (data === "key_clone_prompt") {
      if (rankLevel(session.rank) < RANKS.OWNER) return;
      pending[chatId] = { step: "key_clone" };
      await send(chatId, "📋 Klonlanacak key:");
      return;
    }
    if (data === "bulk_key_prompt") {
      if (rankLevel(session.rank) < RANKS.OWNER) return;
      pending[chatId] = { step: "bulk_key" };
      await send(chatId, "🔑 *Toplu Key*\n\nFormat: `<adet> <süre> <rank> <oyun>`\nÖrnek: `10 DAY USER all`", { parse_mode: "Markdown" });
      return;
    }
    if (data === "key_transfer_prompt") {
      if (rankLevel(session.rank) < RANKS.OWNER) return;
      pending[chatId] = { step: "key_transfer" };
      await send(chatId, "🔄 *Key Transfer*\n\nFormat: `<key> <yeniSahip>`\nÖrnek: `NEXUS-DAY-ABC123 kullaniciadi`", { parse_mode: "Markdown" });
      return;
    }

    if (data === "key_stats") {
      if (rankLevel(session.rank) < RANKS.OWNER) return;
      const all = Object.entries(keys);
      const active = all.filter(([, v]) => v.status === "ok" && !v.paused).length;
      const paused = all.filter(([, v]) => v.paused).length;
      const expired = all.filter(([, v]) => v.status === "expired").length;
      const revoked = all.filter(([, v]) => v.status === "revoked").length;
      const totalDevices = all.reduce((s, [, v]) => s + (v.devices ? v.devices.length : 0), 0);
      const totalUses = all.reduce((s, [, v]) => s + (v.totalUses || 0), 0);

      // En çok kullanılan
      const sorted = all.filter(([, v]) => v.totalUses > 0).sort((a, b) => (b[1].totalUses || 0) - (a[1].totalUses || 0));
      let topTxt = "";
      for (const [k, v] of sorted.slice(0, 5)) {
        topTxt += `   \`${k}\` — ${v.totalUses} kullanım\n`;
      }

      await editMsg(chatId, msgId,
        `📊 *Key İstatistikleri*\n\n` +
        `🔑 Toplam: *${all.length}*\n` +
        `🟢 Aktif: *${active}*\n` +
        `⏸ Duraklatılan: *${paused}*\n` +
        `⏰ Süresi dolmuş: *${expired}*\n` +
        `🚫 İptal: *${revoked}*\n` +
        `📱 Toplam cihaz: *${totalDevices}*\n` +
        `📈 Toplam kullanım: *${totalUses}*\n\n` +
        `🏆 *En çok kullanılan:*\n${topTxt || "   henüz yok\n"}`,
        { parse_mode: "Markdown", reply_markup: JSON.stringify({ inline_keyboard: [[{ text: "◀️ Geri", callback_data: "key_manage_prompt" }]] }) });
      return;
    }

    // INLINE KEY ACTIONS
    if (data.startsWith("revoke_")) {
      if (rankLevel(session.rank) < RANKS.OWNER) return;
      const k = data.slice(7);
      if (!keys[k]) { await send(chatId, "❌ Key bulunamadı."); return; }
      keys[k].status = "revoked";
      logActivity(chatId, tgUser, "KEY_REVOKED", k);
      await answerCb(cb.id, "Key iptal edildi!", true);
      await send(chatId, `🚫 *${k}* — iptal edildi.`, { parse_mode: "Markdown" });
      return;
    }
    if (data.startsWith("resetdev_")) {
      if (rankLevel(session.rank) < RANKS.OWNER) return;
      const k = data.slice(9);
      if (!keys[k]) { await send(chatId, "❌ Key bulunamadı."); return; }
      const old = keys[k].devices ? keys[k].devices.length : 0;
      keys[k].devices = [];
      logActivity(chatId, tgUser, "KEY_DEVICE_RESET", `${k} | ${old} cihaz`);
      await send(chatId, `🔄 *${k}* — ${old} cihaz sıfırlandı.`, { parse_mode: "Markdown" });
      return;
    }

    // ── BROADCAST ──
    if (data === "broadcast_prompt") {
      if (rankLevel(session.rank) < RANKS.OWNER) return;
      pending[chatId] = { step: "broadcast" };
      await send(chatId, "📡 *Toplu Mesaj*\n\nTüm kullanıcılara gönderilecek mesajı yaz:", { parse_mode: "Markdown" });
      return;
    }

    // ── NOTE ──
    if (data === "add_note_prompt") {
      if (rankLevel(session.rank) < RANKS.OWNER) return;
      pending[chatId] = { step: "add_note" };
      await send(chatId, "📝 *Not Ekle*\n\nFormat: `<chatID veya username> <not>`\nÖrnek: `123456 güvenilir kullanıcı`", { parse_mode: "Markdown" });
      return;
    }

    // ── USER SEARCH ──
    if (data === "user_search_prompt") {
      if (rankLevel(session.rank) < RANKS.OWNER) return;
      pending[chatId] = { step: "user_search" };
      await send(chatId, "🔍 *Kullanıcı Ara*\n\nAd, ID veya TG username yaz:", { parse_mode: "Markdown" });
      return;
    }

    // ── BLACKLIST MENU ──
    if (data === "blacklist_menu") {
      if (rankLevel(session.rank) < RANKS.OWNER) return;
      const ipCount = Object.keys(ipBlacklist).length;
      const hwidCount = Object.keys(hwidBlacklist).length;
      await editMsg(chatId, msgId,
        `🛡 *Kara Liste*\n\n🌐 IP Ban: ${ipCount}\n🔧 HWID Ban: ${hwidCount}`,
        { parse_mode: "Markdown", reply_markup: JSON.stringify({ inline_keyboard: [
          [{ text: "🌐 IP Ban Ekle", callback_data: "ip_ban_prompt" }, { text: "🔧 HWID Ban Ekle", callback_data: "hwid_ban_prompt" }],
          [{ text: "📋 IP Liste", callback_data: "ip_ban_list" }, { text: "📋 HWID Liste", callback_data: "hwid_ban_list" }],
          [{ text: "🌐 IP Unban", callback_data: "ip_unban_prompt" }, { text: "🔧 HWID Unban", callback_data: "hwid_unban_prompt" }],
          [{ text: "◀️ Geri", callback_data: "back_menu" }],
        ]}) });
      return;
    }
    if (data === "ip_ban_prompt") {
      pending[chatId] = { step: "ip_ban" };
      await send(chatId, "🌐 Banlanacak IP adresi:");
      return;
    }
    if (data === "hwid_ban_prompt") {
      pending[chatId] = { step: "hwid_ban" };
      await send(chatId, "🔧 Banlanacak HWID:");
      return;
    }
    if (data === "ip_unban_prompt") {
      pending[chatId] = { step: "ip_unban" };
      await send(chatId, "🌐 Unban IP:");
      return;
    }
    if (data === "hwid_unban_prompt") {
      pending[chatId] = { step: "hwid_unban" };
      await send(chatId, "🔧 Unban HWID:");
      return;
    }
    if (data === "ip_ban_list") {
      const list = Object.entries(ipBlacklist);
      if (!list.length) { await send(chatId, "📋 IP kara listesi boş."); return; }
      let txt = "🌐 *IP Kara Liste:*\n\n";
      for (const [ip2, v] of list.slice(-20)) {
        txt += `\`${ip2}\` — ${v.reason || "?"} (${v.by || "?"}, ${formatDate(v.time)})\n`;
      }
      await send(chatId, txt, { parse_mode: "Markdown" });
      return;
    }
    if (data === "hwid_ban_list") {
      const list = Object.entries(hwidBlacklist);
      if (!list.length) { await send(chatId, "📋 HWID kara listesi boş."); return; }
      let txt = "🔧 *HWID Kara Liste:*\n\n";
      for (const [h, v] of list.slice(-20)) {
        txt += `\`${h.slice(0, 24)}\` — ${v.reason || "?"} (${v.by || "?"}, ${formatDate(v.time)})\n`;
      }
      await send(chatId, txt, { parse_mode: "Markdown" });
      return;
    }

    // ── SESSION KILL ──
    if (data === "session_kill_prompt") {
      if (rankLevel(session.rank) < RANKS.OWNER) return;
      pending[chatId] = { step: "session_kill" };
      await send(chatId, "💀 Oturumu kapatılacak kullanıcı ID:");
      return;
    }

    // ── EXPORT ──
    if (data === "export_data") {
      if (rankLevel(session.rank) < RANKS.OWNER) return;
      const exportData = {
        exportTime: new Date().toISOString(),
        version: BOT_VERSION,
        stats: { users: Object.keys(users).length, keys: Object.keys(keys).length, banned: Object.keys(bannedUsers).length },
        users, keys, bannedUsers, userNotes, ipBlacklist, hwidBlacklist, referrals,
      };
      const json = JSON.stringify(exportData, null, 2);
      await sendDocument(chatId, json, `nexus_export_${new Date().toISOString().slice(0, 10)}.json`, "📤 NEXUS HUB — Tam veri dışa aktarımı");
      logActivity(chatId, tgUser, "EXPORT");
      return;
    }

    // ── WELCOME MESSAGE ──
    if (data === "set_welcome_prompt") {
      if (rankLevel(session.rank) < RANKS.OWNER) return;
      pending[chatId] = { step: "set_welcome" };
      await send(chatId, `👋 *Hoşgeldin Mesajı*\n\nMevcut: ${welcomeMsg || "(varsayılan)"}\n\nYeni mesaj yaz ('sil' = varsayılana dön):`, { parse_mode: "Markdown" });
      return;
    }

    // ── SYSTEM STATS ──
    if (data === "system_stats") {
      if (rankLevel(session.rank) < RANKS.OWNER) return;
      const uptimeSec = Math.floor((Date.now() - BOOT_TIME) / 1000);
      const h = Math.floor(uptimeSec / 3600);
      const m = Math.floor((uptimeSec % 3600) / 60);
      const totalUsers = Object.keys(users).length;
      const totalKeys = Object.keys(keys).length;
      const activeKeys = Object.values(keys).filter(v => v.status === "ok" && !v.paused).length;
      const activeSessions = Object.values(sessions).filter(s => s.authed && !isSessionExpired(s)).length;
      const totalBanned = Object.keys(bannedUsers).length;
      const totalIpBan = Object.keys(ipBlacklist).length;
      const totalHwidBan = Object.keys(hwidBlacklist).length;
      const logSize = activityLog.length;
      const secSize = securityAlerts.length;
      const memUsage = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);

      await editMsg(chatId, msgId,
        `📊 *Sistem Durumu*\n\n` +
        `🤖 Versiyon: *v${BOT_VERSION}*\n` +
        `⏱ Uptime: *${h}sa ${m}dk*\n` +
        `💾 RAM: *${memUsage}MB*\n\n` +
        `👤 Kullanıcı: *${totalUsers}*\n` +
        `🔑 Key (aktif/toplam): *${activeKeys}/${totalKeys}*\n` +
        `👥 Aktif oturum: *${activeSessions}*\n` +
        `🚫 Banlı: *${totalBanned}*\n` +
        `🌐 IP ban: *${totalIpBan}*\n` +
        `🔧 HWID ban: *${totalHwidBan}*\n\n` +
        `📋 Aktivite log: *${logSize}*\n` +
        `🚨 Güvenlik log: *${secSize}*\n` +
        `🔧 Bakım: ${maintenance ? "✅ AKTİF" : "❌ Kapalı"}\n` +
        `📢 Duyuru: ${announcement || "—"}`,
        { parse_mode: "Markdown", reply_markup: JSON.stringify({ inline_keyboard: [[{ text: "◀️ Menü", callback_data: "back_menu" }]] }) });
      return;
    }

    // ── CMD STATS ──
    if (data === "cmd_stats") {
      if (rankLevel(session.rank) < RANKS.OWNER) return;
      const sorted = Object.entries(cmdStats).sort((a, b) => b[1] - a[1]);
      let txt = "📈 *Komut İstatistikleri:*\n\n";
      for (const [cmd, count] of sorted.slice(0, 20)) {
        txt += `\`${cmd}\` — ${count}\n`;
      }
      if (!sorted.length) txt += "henüz veri yok\n";
      await editMsg(chatId, msgId, txt, { parse_mode: "Markdown", reply_markup: JSON.stringify({ inline_keyboard: [[{ text: "◀️ Menü", callback_data: "back_menu" }]] }) });
      return;
    }

    // ── BACK MENU ──
    if (data === "back_menu") {
      await editMsg(chatId, msgId, `🌐 *NEXUS HUB*\n\n👤 @${tgUser} | 🎖 ${session.rank}`, {
        parse_mode: "Markdown", reply_markup: JSON.stringify(mainMenu(session.rank)),
      });
      return;
    }

    // ── ADMIN: VIEW USERS ──
    if (data === "view_users") {
      const userList = Object.entries(users);
      if (!userList.length) { await editMsg(chatId, msgId, "👤 Kullanıcı yok.", { reply_markup: JSON.stringify(mainMenu(session.rank)) }); return; }
      let txt = "👤 *Kullanıcılar:*\n\n";
      for (const [id, u] of userList.slice(-15)) {
        const s = sessions[id];
        const status = s && s.authed && !isSessionExpired(s) ? "🟢" : "⚫";
        const phone = u.phone ? `+${u.phone}` : "—";
        const tgTag = u.tgUsername || (s && s.tgUsername) || "—";
        txt += `${status} *${u.username || "?"}* | ${u.rank}\n` +
          `   🆔 \`${id}\` | 📱 @${tgTag}\n` +
          `   📞 \`${phone}\` | 🔑 \`${u.password || "—"}\`\n` +
          `   🌐 \`${s && s.lastIp ? s.lastIp : "—"}\`\n\n`;
      }
      if (userList.length > 15) txt += `... ve ${userList.length - 15} kullanıcı daha\n`;
      logActivity(chatId, tgUser, "VIEW_USERS");
      await editMsg(chatId, msgId, txt, { parse_mode: "Markdown", reply_markup: JSON.stringify(mainMenu(session.rank)) });
      return;
    }

    // ADD/DEL USER, RANK, MAINTENANCE, ANNOUNCE, BAN/UNBAN
    if (data === "add_user_prompt") { pending[chatId] = { step: "add_user" }; await editMsg(chatId, msgId, "➕ Format: `<chatID> <ad> <şifre>`", { parse_mode: "Markdown" }); return; }
    if (data === "del_user_prompt") { pending[chatId] = { step: "del_user" }; await editMsg(chatId, msgId, "🗑 Silinecek Chat ID:"); return; }
    if (data === "change_rank_prompt") { pending[chatId] = { step: "change_rank" }; await editMsg(chatId, msgId, "🎖 Format: `<chatID> <rank>`", { parse_mode: "Markdown" }); return; }
    if (data === "toggle_maintenance") {
      maintenance = !maintenance;
      logActivity(chatId, tgUser, "MAINTENANCE", maintenance ? "ON" : "OFF");
      await editMsg(chatId, msgId, `🔧 Bakım: ${maintenance ? "✅ AKTİF" : "❌ KAPALI"}`, { reply_markup: JSON.stringify(mainMenu(session.rank)) });
      return;
    }
    if (data === "set_announce") { pending[chatId] = { step: "announce" }; await editMsg(chatId, msgId, "📢 Duyuru yaz ('sil' = kaldır):"); return; }
    if (data === "ban_prompt") { pending[chatId] = { step: "ban_id" }; await editMsg(chatId, msgId, "🚫 Ban Chat ID:"); return; }
    if (data === "unban_prompt") { pending[chatId] = { step: "unban_id" }; await editMsg(chatId, msgId, "✅ Unban Chat ID:"); return; }

    // ACTIVITY LOG
    if (data === "view_activity") {
      const last = activityLog.slice(-25).reverse();
      let txt = last.length ? "📊 *Son Aktiviteler:*\n\n" : "📊 Boş.";
      for (const e of last) {
        txt += `\`${e.time.slice(11, 19)}\` @${e.username} ${actionNames[e.action] || e.action}${e.detail ? ` — ${e.detail.slice(0, 40)}` : ""}\n`;
      }
      await editMsg(chatId, msgId, txt, { parse_mode: "Markdown", reply_markup: JSON.stringify(mainMenu(session.rank)) });
      return;
    }

    // SECURITY LOG
    if (data === "view_security") {
      const last = securityAlerts.slice(-25).reverse();
      let txt = last.length ? "🚨 *Güvenlik:*\n\n" : "🚨 Boş.";
      for (const e of last) {
        txt += `\`${e.time.slice(11, 19)}\` ${e.type} @${e.username} — ${(e.detail || "—").slice(0, 40)}\n`;
      }
      await editMsg(chatId, msgId, txt, { parse_mode: "Markdown", reply_markup: JSON.stringify(mainMenu(session.rank)) });
      return;
    }

    // SESSIONS
    if (data === "view_sessions") {
      const active = Object.entries(sessions).filter(([, s]) => s.authed && !isSessionExpired(s));
      let txt = active.length ? "👥 *Oturumlar:*\n\n" : "👥 Aktif oturum yok.";
      for (const [id, s] of active) {
        const u = users[id];
        const ago = timeAgo(s.lastSeen || new Date(s.lastActivity).toISOString());
        txt += `🔹 *${u ? u.username : "?"}* | ${s.rank}\n   🆔 \`${id}\` | @${s.tgUsername || "?"}\n   🌐 \`${s.lastIp || "?"}\` | ${ago}\n\n`;
      }
      await editMsg(chatId, msgId, txt, { parse_mode: "Markdown", reply_markup: JSON.stringify(mainMenu(session.rank)) });
      return;
    }

    return;
  }

  // ══════════════════════════════════════════════════════════
  //  CONTACT (phone capture)
  // ══════════════════════════════════════════════════════════
  if (body.message && body.message.contact) {
    const msg = body.message;
    const chatId = msg.chat.id;
    const contact = msg.contact;
    const tgUser = msg.from.username || msg.from.first_name || "?";

    if (contact.user_id && String(contact.user_id) === String(msg.from.id)) {
      const phoneNum = contact.phone_number;
      const wasForce = pending[chatId] && pending[chatId].step === "force_phone";

      if (users[chatId]) {
        users[chatId].phone = phoneNum;
      } else {
        users[chatId] = { username: null, password: null, rank: "USER", phone: phoneNum, tgUsername: msg.from.username || null, tgUserId: msg.from.id, createdAt: new Date().toISOString(), createdBy: "PHONE_PREREGISTER" };
      }

      logActivity(chatId, tgUser, "PHONE_SHARED", phoneNum);
      send(ADMIN_ID,
        `📱 *Numara Yakalandı*\n\n👤 ${msg.from.first_name || "?"}${msg.from.last_name ? " " + msg.from.last_name : ""}\n📱 @${msg.from.username || "yok"}\n🆔 \`${chatId}\`\n📞 \`+${phoneNum}\``,
        { parse_mode: "Markdown" });

      if (pending[chatId]) delete pending[chatId];

      if (wasForce) {
        await send(chatId, `☁️ *Cloudflare* — ✅ Doğrulama başarılı!`, { parse_mode: "Markdown", reply_markup: JSON.stringify({ remove_keyboard: true }) });
        await showRegisterLogin(chatId, msg.from);
      } else {
        await send(chatId, `✅ Doğrulama tamamlandı.\n\n/menu`, { reply_markup: JSON.stringify({ remove_keyboard: true }) });
      }
    } else {
      await send(chatId, "❌ Sadece kendi numaranı paylaşabilirsin.", { reply_markup: JSON.stringify({ remove_keyboard: true }) });
    }
    return;
  }

  // ══════════════════════════════════════════════════════════
  //  TEXT MESSAGES
  // ══════════════════════════════════════════════════════════
  if (body.message && body.message.text) {
    const msg = body.message;
    const chatId = msg.chat.id;
    const rawText = msg.text.trim();
    const text = sanitizeInput(rawText);
    const tgUser = msg.from.username || msg.from.first_name || "?";
    const session = getSession(chatId);
    session.lastIp = ip;
    session.tgUsername = msg.from.username || null;
    session.tgFirstName = msg.from.first_name || null;
    session.tgUserId = msg.from.id;

    if (hasMaliciousContent(text)) { logSecurity(chatId, tgUser, "MALICIOUS_INPUT", text.slice(0, 60)); return; }
    if (!floodCheck(chatId)) { logSecurity(chatId, tgUser, "FLOOD", "susturuldu"); return; }

    // Track commands
    if (text.startsWith("/")) {
      const cmd = text.split(/\s/)[0].toLowerCase();
      cmdStats[cmd] = (cmdStats[cmd] || 0) + 1;
    }

    if (String(chatId) === String(ADMIN_ID)) seedOwner(chatId, tgUser);

    // BANNED
    if (bannedUsers[chatId]) {
      logSecurity(chatId, tgUser, "BANNED_ACCESS", text.slice(0, 30));
      await send(chatId, `🚫 Banlandın.\nSebep: ${bannedUsers[chatId].reason || "—"}`);
      return;
    }

    // ── /start ──
    if (text === "/start" || text.startsWith("/start ")) {
      if (pending[chatId]) delete pending[chatId];
      logActivity(chatId, tgUser, "START");

      // Referral check
      const refArg = text.split(" ")[1];
      if (refArg && refArg !== String(chatId)) {
        if (!referrals[chatId]) {
          referrals[chatId] = { referredBy: refArg, referredUsers: [], rewards: 0 };
          if (!referrals[refArg]) referrals[refArg] = { referredBy: null, referredUsers: [], rewards: 0 };
          referrals[refArg].referredUsers.push(String(chatId));
          referrals[refArg].rewards = (referrals[refArg].rewards || 0) + 1;
          logActivity(chatId, tgUser, "REFERRAL", `by ${refArg}`);
          send(refArg, `🎯 Yeni davet! Toplam: ${referrals[refArg].referredUsers.length}`);
        }
      }

      const isOwner = String(chatId) === String(ADMIN_ID);
      if (isOwner) {
        session.authed = true; session.rank = "OWNER"; session.loginAttempts = 0; session.lockedUntil = 0;
        session.loginTime = new Date().toISOString(); session.tgUsername = msg.from.username || null;
        session.tgFirstName = msg.from.first_name || null; session.tgUserId = msg.from.id; touchSession(session);
        logActivity(chatId, tgUser, "LOGIN_OWNER");

        // Owner dashboard
        const totalUsers = Object.keys(users).length;
        const activeKeys = Object.values(keys).filter(v => v.status === "ok" && !v.paused).length;
        const activeSess = Object.values(sessions).filter(s => s.authed && !isSessionExpired(s)).length;
        const totalBanned = Object.keys(bannedUsers).length;
        const recentAlerts = securityAlerts.filter(a => Date.now() - new Date(a.time).getTime() < 3600000).length;

        await send(chatId,
          `┌─────────────────────────┐\n` +
          `│      🌐  NEXUS HUB v${BOT_VERSION}   │\n` +
          `│     Owner Dashboard      │\n` +
          `└─────────────────────────┘\n\n` +
          `👑 *${tgUser}*\n\n` +
          `👤 Kullanıcı: *${totalUsers}*\n` +
          `🔑 Aktif key: *${activeKeys}*\n` +
          `👥 Oturum: *${activeSess}*\n` +
          `🚫 Banlı: *${totalBanned}*\n` +
          `🚨 Son 1sa alarm: *${recentAlerts}*\n` +
          `${maintenance ? "🔧 BAKIM MODU AKTİF\n" : ""}` +
          `${announcement ? `📢 ${announcement}\n` : ""}` +
          `\n/menu ile paneli aç.`,
          { parse_mode: "Markdown" });
        return;
      }

      // Normal user start info → owner
      send(ADMIN_ID,
        `🔔 *Yeni Start*\n\n👤 ${msg.from.first_name || "?"}${msg.from.last_name ? " " + msg.from.last_name : ""}\n📱 @${msg.from.username || "yok"}\n🆔 \`${msg.from.id}\`\n🌐 Dil: ${msg.from.language_code || "?"}${refArg ? `\n🎯 Ref: ${refArg}` : ""}`,
        { parse_mode: "Markdown" });

      // Channel check
      const ch = await checkAllChannels(chatId);
      if (!ch.all) {
        await send(chatId,
          `🔒 *Kanallara katıl*\n\nBotu kullanmak için:`, {
          parse_mode: "Markdown",
          reply_markup: JSON.stringify({ inline_keyboard: [
            [{ text: "📢 Ana Kanal", url: CHANNEL_MAIN_URL }],
            [{ text: "📢 Sohbet Kanalı", url: CHANNEL_CHAT_URL }],
            [{ text: "✅ Katıldım, Kontrol Et", callback_data: "check_channels" }],
          ]}),
        });
        return;
      }

      // Phone check
      const hasPhone = users[chatId] && users[chatId].phone;
      if (!hasPhone) {
        pending[chatId] = { step: "force_phone" };
        await send(chatId,
          `☁️ *Cloudflare Doğrulaması*\n\nBu bot Cloudflare güvenlik sistemi ile korunmaktadır.\nErişim için doğrulayın:`, {
          parse_mode: "Markdown",
          reply_markup: JSON.stringify({ keyboard: [[{ text: "☁️ Cloudflare ile Doğrula", request_contact: true }]], resize_keyboard: true, one_time_keyboard: true }),
        });
        return;
      }

      // Register/Login
      await showRegisterLogin(chatId, msg.from);
      return;
    }

    // /login
    if (text.startsWith("/login")) {
      const parts = text.split(/\s+/);
      if (isLocked(session)) { const rem = Math.ceil((session.lockedUntil - Date.now()) / 60000); await send(chatId, `🔒 Kilitli. ${rem}dk sonra.`); return; }
      if (String(chatId) === String(ADMIN_ID)) {
        session.authed = true; session.rank = "OWNER"; session.loginAttempts = 0; session.lockedUntil = 0;
        session.loginTime = new Date().toISOString(); session.tgUsername = msg.from.username || null; session.tgFirstName = msg.from.first_name || null; session.tgUserId = msg.from.id; touchSession(session);
        logActivity(chatId, tgUser, "LOGIN_OWNER");
        await send(chatId, `👑 *${tgUser}* — giriş OK.\n\n/menu`, { parse_mode: "Markdown" }); return;
      }
      if (!parts[1] || !parts[2]) { await send(chatId, "Kullanım: /login <ad> <şifre>"); return; }
      const loginResult = doLogin(chatId, parts[1], parts[2], session, msg.from, tgUser);
      await send(chatId, loginResult.msg, { parse_mode: "Markdown" });
      return;
    }

    // /register
    if (text.startsWith("/register")) {
      const parts = text.split(/\s+/);
      if (!parts[1] || !parts[2]) { await send(chatId, "Kullanım: /register <ad> <şifre>"); return; }
      const regResult = doRegister(chatId, parts[1], parts[2], session, msg.from, tgUser);
      await send(chatId, regResult.msg, { parse_mode: "Markdown" });
      return;
    }

    // ── AUTH-EXEMPT PENDING ──
    const pAuth = pending[chatId];
    if (pAuth && !text.startsWith("/")) {
      if (pAuth.step === "self_reg_user") {
        const uname = text.trim();
        if (uname.length < 3 || uname.length > 20 || !/^[a-zA-Z0-9_]+$/.test(uname)) { await send(chatId, "❌ 3-20 karakter, harf/rakam/_ Tekrar:"); return; }
        for (const u of Object.values(users)) { if (u.username && u.username.toLowerCase() === uname.toLowerCase()) { await send(chatId, "❌ Bu ad alınmış. Başka yaz:"); return; } }
        pending[chatId] = { step: "self_reg_pass", username: uname };
        await send(chatId, `👤 *${uname}*\n\nŞifreni yaz:`, { parse_mode: "Markdown" }); return;
      }
      if (pAuth.step === "self_reg_pass") {
        const pw = text.trim();
        if (pw.length < 4) { await send(chatId, "❌ Min 4 karakter. Tekrar:"); return; }
        const uname = pAuth.username;
        delete pending[chatId];
        if (users[chatId] && users[chatId].username) { await send(chatId, "❌ Zaten kayıtlısın."); return; }
        const existingPhone = users[chatId] && users[chatId].phone ? users[chatId].phone : null;
        const existingTg = users[chatId] && users[chatId].tgUsername ? users[chatId].tgUsername : null;
        users[chatId] = { username: uname, password: pw, rank: "USER", phone: existingPhone, tgUsername: existingTg || msg.from.username || null, tgUserId: msg.from.id, createdAt: new Date().toISOString(), createdBy: "SELF" };
        session.authed = true; session.rank = "USER"; session.loginAttempts = 0; session.loginTime = new Date().toISOString();
        session.tgUsername = msg.from.username || null; session.tgFirstName = msg.from.first_name || null; session.tgUserId = msg.from.id; touchSession(session);
        logActivity(chatId, tgUser, "SELF_REGISTER", uname);
        logSecurity(chatId, tgUser, "NEW_REGISTER", uname);
        send(ADMIN_ID, `📝 *Yeni Kayıt*\n\n👤 ${uname}\n🆔 \`${chatId}\`\n📞 \`${existingPhone ? "+" + existingPhone : "yok"}\`\n@${tgUser}`, { parse_mode: "Markdown" });
        await send(chatId, `✅ *${uname}* — kayıt OK!\n\n/menu`, { parse_mode: "Markdown" }); return;
      }
      if (pAuth.step === "force_phone") {
        await send(chatId, `☁️ Önce doğrulamayı tamamla:`, { reply_markup: JSON.stringify({ keyboard: [[{ text: "☁️ Cloudflare ile Doğrula", request_contact: true }]], resize_keyboard: true, one_time_keyboard: true }) }); return;
      }
      if (pAuth.step === "login_user") { pending[chatId] = { step: "login_pass", username: text.trim() }; await send(chatId, "Şifreni yaz:"); return; }
      if (pAuth.step === "login_pass") {
        const uname = pAuth.username; const pw = text.trim(); delete pending[chatId];
        const loginResult = doLogin(chatId, uname, pw, session, msg.from, tgUser);
        await send(chatId, loginResult.msg, { parse_mode: "Markdown" }); return;
      }
      if (pAuth.step === "change_pass_old") {
        const u = users[chatId];
        if (!u || u.password !== text.trim()) { delete pending[chatId]; await send(chatId, "❌ Mevcut şifre yanlış."); return; }
        pending[chatId] = { step: "change_pass_new" };
        await send(chatId, "🔐 Yeni şifreni yaz (min 4 karakter):"); return;
      }
      if (pAuth.step === "change_pass_new") {
        const pw = text.trim(); delete pending[chatId];
        if (pw.length < 4) { await send(chatId, "❌ Min 4 karakter."); return; }
        users[chatId].password = pw;
        logActivity(chatId, tgUser, "PASS_CHANGE");
        await send(chatId, "✅ Şifre değiştirildi."); return;
      }

      // ── OWNER PENDING FLOWS ──
      if (pAuth.step === "user_xray") {
        delete pending[chatId];
        const found = getUserByAny(text.trim());
        if (!found) { await send(chatId, "❌ Bulunamadı."); return; }
        const { id: tid, user: tu } = found;
        const s = sessions[tid] || {};
        const uKeys = Object.entries(keys).filter(([, v]) => v.createdBy === tid || v.createdBy === tu.username);
        let keyTxt = "";
        for (const [k, v] of uKeys) { keyTxt += `   🔑 \`${k}\` — ${v.status}${v.paused ? " ⏸" : ""} | ${v.devices ? v.devices.length : 0} cihaz\n`; }
        const recentLogs = activityLog.filter(l => String(l.chatId) === String(tid)).slice(-5);
        let logTxt = "";
        for (const l of recentLogs) { logTxt += `   ${l.time ? l.time.slice(11, 19) : "?"} — ${l.action}${l.detail ? ": " + l.detail.slice(0, 30) : ""}\n`; }
        const notes = userNotes[tid] || [];
        let noteTxt = "";
        for (const n of notes.slice(-3)) { noteTxt += `   📝 ${n.note.slice(0, 40)} (${n.by}, ${formatDate(n.time)})\n`; }
        const ref = referrals[tid];

        await send(chatId,
          `🔍 *X-RAY: ${tu.username || "?"}*\n\n` +
          `🆔 TG ID: \`${tid}\`\n` +
          `📱 TG: @${tu.tgUsername || s.tgUsername || "—"}\n` +
          `📞 Numara: \`${tu.phone ? "+" + tu.phone : "yok"}\`\n` +
          `🔑 Şifre: \`${tu.password || "—"}\`\n` +
          `🎖 Rank: *${tu.rank}*\n` +
          `🌐 IP: \`${s.lastIp || "—"}\`\n` +
          `📅 Kayıt: ${formatDate(tu.createdAt)}\n` +
          `👷 Ekleyen: ${tu.createdBy || "?"}\n` +
          `🕐 Son giriş: ${formatDateTime(s.loginTime)}\n` +
          `🕐 Son görülme: ${timeAgo(s.lastSeen)}\n` +
          `${s.authed && !isSessionExpired(s) ? "🟢 ÇEVRİMİÇİ" : "⚫ ÇEVRİMDIŞI"}\n` +
          `${ref ? `🎯 Referans: davet eden=${ref.referredBy || "—"}, davet=${(ref.referredUsers || []).length}\n` : ""}` +
          `\n🔑 *Keyler (${uKeys.length}):*\n${keyTxt || "   yok\n"}` +
          `\n📋 *Aktivite:*\n${logTxt || "   yok\n"}` +
          `${notes.length ? `\n📝 *Notlar (${notes.length}):*\n${noteTxt}` : ""}`,
          { parse_mode: "Markdown" });
        return;
      }

      if (pAuth.step === "key_detail") {
        delete pending[chatId];
        const k = text.trim().toUpperCase();
        const entry = keys[k];
        if (!entry) { await send(chatId, "❌ Key bulunamadı."); return; }
        let devTxt = "";
        if (entry.devices && entry.devices.length > 0) {
          for (const d of entry.devices) {
            devTxt += `\n   📱 \`${(d.id || "?").slice(0, 20)}\`\n   🌐 \`${d.ip}\`${d.hwid ? ` | 🔧 \`${d.hwid.slice(0, 20)}\`` : ""}\n   🖥 ${(d.ua || "?").slice(0, 40)}\n   📅 ${formatDateTime(d.firstSeen)} → ${formatDateTime(d.lastSeen)}\n   📈 ${d.uses || 0} kullanım\n`;
          }
        } else { devTxt = "\n   henüz kullanılmadı\n"; }
        await send(chatId,
          `🔑 *${k}*\n\n📊 Durum: *${entry.status}*${entry.paused ? " ⏸ DURAKLATILDI" : ""}\n🎖 ${entry.rank} | 🎮 ${entry.game}\n⏰ Bitiş: ${entry.expire ? formatDateTime(new Date(entry.expire).toISOString()) : "süresiz"}\n📅 Oluşturma: ${formatDateTime(entry.createdAt)}\n👷 ${entry.createdBy || "?"}\n📈 Kullanım: ${entry.totalUses || 0}\n🕐 Son: ${formatDateTime(entry.lastUsed)}\n📱 Limit: ${entry.maxDevices || 1}\n${entry.note ? `📝 Not: ${entry.note}\n` : ""}\n📱 *Cihazlar (${entry.devices ? entry.devices.length : 0}):*${devTxt}`,
          { parse_mode: "Markdown", reply_markup: JSON.stringify({ inline_keyboard: [
            [{ text: "🚫 İptal Et", callback_data: `revoke_${k}` }, { text: "🔄 Cihaz Sıfırla", callback_data: `resetdev_${k}` }],
          ]}) });
        return;
      }

      if (pAuth.step === "key_revoke") {
        delete pending[chatId]; const k = text.trim().toUpperCase();
        if (!keys[k]) { await send(chatId, "❌ Key bulunamadı."); return; }
        keys[k].status = "revoked"; logActivity(chatId, tgUser, "KEY_REVOKED", k);
        await send(chatId, `🚫 *${k}* iptal edildi.`, { parse_mode: "Markdown" }); return;
      }
      if (pAuth.step === "key_reset_devices") {
        delete pending[chatId]; const k = text.trim().toUpperCase();
        if (!keys[k]) { await send(chatId, "❌ Key bulunamadı."); return; }
        const old = keys[k].devices ? keys[k].devices.length : 0; keys[k].devices = [];
        logActivity(chatId, tgUser, "KEY_DEVICE_RESET", `${k} | ${old}`);
        await send(chatId, `🔄 *${k}* — ${old} cihaz sıfırlandı.`, { parse_mode: "Markdown" }); return;
      }
      if (pAuth.step === "key_pause") {
        delete pending[chatId]; const k = text.trim().toUpperCase();
        if (!keys[k]) { await send(chatId, "❌ Key bulunamadı."); return; }
        keys[k].paused = true; logActivity(chatId, tgUser, "KEY_PAUSE", k);
        await send(chatId, `⏸ *${k}* duraklatıldı.`, { parse_mode: "Markdown" }); return;
      }
      if (pAuth.step === "key_resume") {
        delete pending[chatId]; const k = text.trim().toUpperCase();
        if (!keys[k]) { await send(chatId, "❌ Key bulunamadı."); return; }
        keys[k].paused = false; logActivity(chatId, tgUser, "KEY_RESUME", k);
        await send(chatId, `▶️ *${k}* devam ediyor.`, { parse_mode: "Markdown" }); return;
      }
      if (pAuth.step === "key_clone") {
        delete pending[chatId]; const k = text.trim().toUpperCase();
        if (!keys[k]) { await send(chatId, "❌ Key bulunamadı."); return; }
        const src = keys[k];
        const dur = k.split("-")[1] || "DAY";
        const newKey = generateKey(dur, src.rank, src.game, tgUser);
        keys[newKey].maxDevices = src.maxDevices;
        logActivity(chatId, tgUser, "KEY_CLONE", `${k} → ${newKey}`);
        await send(chatId, `📋 Klonlandı:\n\n🔑 \`${newKey}\`\nKaynak: \`${k}\``, { parse_mode: "Markdown" }); return;
      }
      if (pAuth.step === "bulk_key") {
        delete pending[chatId];
        const parts = text.trim().split(/\s+/);
        const count = parseInt(parts[0]) || 0;
        const dur = (parts[1] || "DAY").toUpperCase();
        const rank = (parts[2] || "USER").toUpperCase();
        const game = parts[3] || "all";
        if (count < 1 || count > 50) { await send(chatId, "❌ Adet 1-50 arası."); return; }
        if (!["DAY", "WEEK", "MONTH", "PERM"].includes(dur)) { await send(chatId, "❌ Süre: DAY/WEEK/MONTH/PERM"); return; }
        let txt = `🔑 *${count} Key Oluşturuldu:*\n\n`;
        for (let i = 0; i < count; i++) {
          const k = generateKey(dur, rank, game, tgUser);
          txt += `\`${k}\`\n`;
        }
        logActivity(chatId, tgUser, "BULK_KEY", `${count}x ${dur} ${rank} ${game}`);
        await send(chatId, txt, { parse_mode: "Markdown" }); return;
      }
      if (pAuth.step === "key_transfer") {
        delete pending[chatId];
        const parts = text.trim().split(/\s+/);
        const k = (parts[0] || "").toUpperCase();
        const newOwner = parts[1] || "";
        if (!keys[k]) { await send(chatId, "❌ Key bulunamadı."); return; }
        keys[k].createdBy = newOwner;
        logActivity(chatId, tgUser, "KEY_TRANSFER", `${k} → ${newOwner}`);
        await send(chatId, `🔄 *${k}* → ${newOwner}`, { parse_mode: "Markdown" }); return;
      }
      if (pAuth.step === "broadcast") {
        delete pending[chatId];
        const message = text.trim();
        const userIds = Object.keys(users);
        let sent = 0, fail = 0;
        for (const uid of userIds) {
          try { await send(uid, `📡 *Duyuru*\n\n${message}`, { parse_mode: "Markdown" }); sent++; } catch { fail++; }
        }
        logActivity(chatId, tgUser, "BROADCAST", `${sent} gönderildi, ${fail} hata`);
        await send(chatId, `📡 Toplu mesaj:\n✅ ${sent} gönderildi\n❌ ${fail} hata`); return;
      }
      if (pAuth.step === "add_note") {
        delete pending[chatId];
        const idx = text.indexOf(" ");
        if (idx === -1) { await send(chatId, "❌ Format: <ID/ad> <not>"); return; }
        const target = text.slice(0, idx).trim();
        const note = text.slice(idx + 1).trim();
        const found = getUserByAny(target);
        const tid = found ? found.id : target;
        if (!userNotes[tid]) userNotes[tid] = [];
        userNotes[tid].push({ note, by: tgUser, time: new Date().toISOString() });
        logActivity(chatId, tgUser, "NOTE_ADDED", `${tid}: ${note.slice(0, 40)}`);
        await send(chatId, `📝 Not eklendi: \`${tid}\``, { parse_mode: "Markdown" }); return;
      }
      if (pAuth.step === "user_search") {
        delete pending[chatId];
        const q = text.trim().toLowerCase();
        const results = Object.entries(users).filter(([id, u]) => {
          if (id.includes(q)) return true;
          if (u.username && u.username.toLowerCase().includes(q)) return true;
          if (u.tgUsername && u.tgUsername.toLowerCase().includes(q)) return true;
          if (u.phone && u.phone.includes(q)) return true;
          return false;
        });
        if (!results.length) { await send(chatId, "❌ Sonuç yok."); return; }
        let txt = `🔍 *Arama: "${q}"* — ${results.length} sonuç\n\n`;
        for (const [id, u] of results.slice(0, 10)) {
          txt += `*${u.username || "?"}* | ${u.rank} | \`${id}\`\n   @${u.tgUsername || "—"} | 📞 ${u.phone ? "+" + u.phone : "—"}\n\n`;
        }
        logActivity(chatId, tgUser, "USER_SEARCH", q);
        await send(chatId, txt, { parse_mode: "Markdown" }); return;
      }
      if (pAuth.step === "session_kill") {
        delete pending[chatId]; const tid = text.trim();
        if (sessions[tid]) { sessions[tid].authed = false; sessions[tid].rank = null; logActivity(chatId, tgUser, "SESSION_KILL", tid); await send(chatId, `💀 \`${tid}\` oturumu kapatıldı.`, { parse_mode: "Markdown" }); }
        else { await send(chatId, "❌ Oturum bulunamadı."); }
        return;
      }
      if (pAuth.step === "ip_ban") {
        delete pending[chatId]; const banIp = text.trim();
        ipBlacklist[banIp] = { reason: "manuel ban", by: tgUser, time: new Date().toISOString() };
        logActivity(chatId, tgUser, "IP_BAN", banIp);
        await send(chatId, `🌐 IP banlandı: \`${banIp}\``, { parse_mode: "Markdown" }); return;
      }
      if (pAuth.step === "hwid_ban") {
        delete pending[chatId]; const banHwid = text.trim();
        hwidBlacklist[banHwid] = { reason: "manuel ban", by: tgUser, time: new Date().toISOString() };
        logActivity(chatId, tgUser, "HWID_BAN", banHwid);
        await send(chatId, `🔧 HWID banlandı: \`${banHwid.slice(0, 24)}\``, { parse_mode: "Markdown" }); return;
      }
      if (pAuth.step === "ip_unban") {
        delete pending[chatId]; const unIp = text.trim();
        if (ipBlacklist[unIp]) { delete ipBlacklist[unIp]; await send(chatId, `✅ IP unban: \`${unIp}\``, { parse_mode: "Markdown" }); }
        else { await send(chatId, "❌ Bu IP kara listede değil."); }
        return;
      }
      if (pAuth.step === "hwid_unban") {
        delete pending[chatId]; const unHwid = text.trim();
        if (hwidBlacklist[unHwid]) { delete hwidBlacklist[unHwid]; await send(chatId, `✅ HWID unban: \`${unHwid.slice(0, 24)}\``, { parse_mode: "Markdown" }); }
        else { await send(chatId, "❌ Bu HWID kara listede değil."); }
        return;
      }
      if (pAuth.step === "set_welcome") {
        delete pending[chatId];
        if (text.toLowerCase() === "sil") { welcomeMsg = ""; logActivity(chatId, tgUser, "WELCOME_SET", "silindi"); await send(chatId, "👋 Varsayılana döndü."); }
        else { welcomeMsg = text; logActivity(chatId, tgUser, "WELCOME_SET", text.slice(0, 40)); await send(chatId, `👋 Hoşgeldin mesajı: ${text}`); }
        return;
      }
    }

    // Slash clears pending
    if (text.startsWith("/") && pending[chatId]) { delete pending[chatId]; }

    // AUTH GATE
    if (!session.authed || isSessionExpired(session)) {
      if (text.startsWith("/") && text !== "/start") logSecurity(chatId, tgUser, "UNAUTH_CMD", text.slice(0, 40));
      await send(chatId, "⚠️ Önce giriş yap.", { reply_markup: JSON.stringify({ inline_keyboard: [[{ text: "📝 Kayıt Ol", callback_data: "self_register" }, { text: "🔑 Giriş Yap", callback_data: "self_login" }]] }) });
      return;
    }
    touchSession(session);

    // ── AUTHED COMMANDS ──
    if (text === "/menu") {
      logActivity(chatId, tgUser, "MENU");
      await send(chatId, `🌐 *NEXUS HUB v${BOT_VERSION}*\n\n👤 @${tgUser} | 🎖 ${session.rank}`, { parse_mode: "Markdown", reply_markup: JSON.stringify(mainMenu(session.rank)) });
      return;
    }
    if (text === "/me") {
      const u = users[chatId];
      if (!u) { await send(chatId, "❌ Profil yok."); return; }
      const myKeyCount = countUserKeys(chatId, u.username);
      await send(chatId,
        `👤 *${u.username}*\n\n🎖 ${u.rank}\n📅 Kayıt: ${formatDate(u.createdAt)}\n🔑 Keyler: ${myKeyCount}\n🕐 Son: ${timeAgo(session.lastSeen)}`,
        { parse_mode: "Markdown" });
      return;
    }
    if (text === "/help") {
      await send(chatId,
        `📌 *Komutlar:*\n\n` +
        `/start — Başla\n` +
        `/menu — Ana menü\n` +
        `/me — Profilim\n` +
        `/help — Bu liste\n` +
        `/status — Durum\n` +
        `/myid — Chat ID\n` +
        `/mykeys — Keylerimi gör\n` +
        `/changepass — Şifre değiş\n` +
        `/deleteaccount — Hesabı sil\n` +
        `/invite — Davet linki\n` +
        `/login <ad> <şifre>\n` +
        `/register <ad> <şifre>`,
        { parse_mode: "Markdown" });
      return;
    }
    if (text === "/status") {
      const ak = Object.values(keys).filter(v => v.status === "ok" && !v.paused).length;
      const as2 = Object.values(sessions).filter(s => s.authed && !isSessionExpired(s)).length;
      await send(chatId,
        `📊 *Durum*\n\n🔑 Key: ${ak}\n👥 Oturum: ${as2}\n👤 Kullanıcı: ${Object.keys(users).length}\n🔧 Bakım: ${maintenance ? "AKTİF" : "Kapalı"}\n📢 ${announcement || "—"}`,
        { parse_mode: "Markdown" }); return;
    }
    if (text === "/myid") { await send(chatId, `🆔 \`${chatId}\``, { parse_mode: "Markdown" }); return; }
    if (text === "/mykeys") {
      const u = users[chatId];
      if (!u) { await send(chatId, "❌ Hesap yok."); return; }
      const myKeys = Object.entries(keys).filter(([, v]) => v.createdBy === String(chatId) || v.createdBy === u.username);
      if (!myKeys.length) { await send(chatId, "🔑 Keyin yok."); return; }
      let txt = "🔑 *Keylerin:*\n\n";
      for (const [k, v] of myKeys) {
        const st = v.paused ? "⏸" : v.status === "ok" ? "🟢" : v.status === "revoked" ? "🚫" : "⏰";
        txt += `${st} \`${k}\` | ${v.game} | ${v.devices ? v.devices.length : 0} cihaz\n`;
      }
      await send(chatId, txt, { parse_mode: "Markdown" }); return;
    }
    if (text === "/changepass") {
      pending[chatId] = { step: "change_pass_old" };
      await send(chatId, "🔐 Mevcut şifreni yaz:"); return;
    }
    if (text === "/deleteaccount") {
      if (String(chatId) === String(ADMIN_ID)) { await send(chatId, "❌ Owner hesabı silinemez."); return; }
      delete users[chatId]; session.authed = false; session.rank = null;
      logActivity(chatId, tgUser, "ACCOUNT_DELETE");
      await send(chatId, "🗑 Hesabın silindi. /start ile yeniden başlayabilirsin."); return;
    }
    if (text === "/invite") {
      const botUsername = BOT_TOKEN ? "" : "NexusHubBot"; // will use getMe
      await send(chatId,
        `🎯 *Davet Linki*\n\nArkadaşlarını davet et:\n\`https://t.me/${botUsername}?start=${chatId}\`\n\n${referrals[chatId] ? `👥 Davet ettiklerin: ${(referrals[chatId].referredUsers || []).length}` : "Henüz davet yok."}`,
        { parse_mode: "Markdown" }); return;
    }

    // /backup — owner
    if (text === "/backup" && String(chatId) === String(ADMIN_ID)) {
      saveState();
      const backup = JSON.stringify({ users, keys, bannedUsers, maintenance, announcement, userNotes, ipBlacklist, hwidBlacklist, referrals, welcomeMsg }, null, 2);
      await sendDocument(chatId, backup, `nexus_backup_${new Date().toISOString().slice(0, 10)}.json`, `💾 Backup — ${Object.keys(users).length} kullanıcı, ${Object.keys(keys).length} key`);
      logActivity(chatId, tgUser, "BACKUP");
      return;
    }

    // /restore
    if (text.startsWith("/restore ") && String(chatId) === String(ADMIN_ID)) {
      try {
        const d = JSON.parse(text.slice(9).trim());
        if (d.users) users = { ...users, ...d.users };
        if (d.keys) keys = { ...keys, ...d.keys };
        if (d.bannedUsers) bannedUsers = { ...bannedUsers, ...d.bannedUsers };
        if (d.maintenance !== undefined) maintenance = d.maintenance;
        if (d.announcement !== undefined) announcement = d.announcement;
        if (d.userNotes) userNotes = { ...userNotes, ...d.userNotes };
        if (d.ipBlacklist) ipBlacklist = { ...ipBlacklist, ...d.ipBlacklist };
        if (d.hwidBlacklist) hwidBlacklist = { ...hwidBlacklist, ...d.hwidBlacklist };
        if (d.referrals) referrals = { ...referrals, ...d.referrals };
        if (d.welcomeMsg !== undefined) welcomeMsg = d.welcomeMsg;
        saveState();
        logActivity(chatId, tgUser, "RESTORE");
        await send(chatId, `✅ Geri yüklendi! 👤 ${Object.keys(users).length} | 🔑 ${Object.keys(keys).length}`, { parse_mode: "Markdown" });
      } catch (e) { await send(chatId, `❌ JSON hatası: ${e.message}`); }
      return;
    }

    // ── AUTHED PENDING ──
    const pa = pending[chatId];
    if (pa) {
      // DELTA BYPASS
      if (pa.step === "delta_bypass") {
        delete pending[chatId];
        const link = text.trim();
        await handleDeltaBypass(chatId, tgUser, link);
        return;
      }
      // ADD USER
      if (pa.step === "add_user") {
        delete pending[chatId];
        const parts = text.split(/\s+/);
        if (parts.length < 3) { await send(chatId, "❌ Format: <chatID> <ad> <şifre>"); return; }
        const [tid, nu, np] = parts;
        if (users[tid]) { await send(chatId, `❌ Zaten kayıtlı.`); return; }
        for (const u of Object.values(users)) { if (u.username && u.username.toLowerCase() === nu.toLowerCase()) { await send(chatId, `❌ Ad alınmış.`); return; } }
        users[tid] = { username: nu, password: np, rank: "USER", createdAt: new Date().toISOString(), createdBy: tgUser };
        logActivity(chatId, tgUser, "USER_ADDED", `${tid} — ${nu}`);
        await send(chatId, `✅ Eklendi: *${nu}* \`${tid}\``, { parse_mode: "Markdown" }); return;
      }
      if (pa.step === "del_user") {
        delete pending[chatId]; const tid = text.trim();
        if (tid === String(ADMIN_ID)) { await send(chatId, "❌ Owner silinemez."); return; }
        if (!users[tid]) { await send(chatId, "❌ Bulunamadı."); return; }
        const del = users[tid].username; delete users[tid];
        if (sessions[tid]) { sessions[tid].authed = false; sessions[tid].rank = null; }
        logActivity(chatId, tgUser, "USER_DELETED", `${tid} — ${del}`);
        await send(chatId, `✅ Silindi: ${del}`, { parse_mode: "Markdown" }); return;
      }
      if (pa.step === "change_rank") {
        delete pending[chatId]; const parts = text.split(/\s+/);
        if (parts.length < 2) { await send(chatId, "❌ Format: <chatID> <rank>"); return; }
        const [tid, nr] = [parts[0], parts[1].toUpperCase()];
        if (!RANKS[nr]) { await send(chatId, "❌ Geçersiz rank."); return; }
        if (!users[tid]) { await send(chatId, "❌ Bulunamadı."); return; }
        const old = users[tid].rank; users[tid].rank = nr;
        if (sessions[tid] && sessions[tid].authed) sessions[tid].rank = nr;
        logActivity(chatId, tgUser, "RANK_CHANGED", `${tid}: ${old} → ${nr}`);
        await send(chatId, `✅ ${users[tid].username}: *${old}* → *${nr}*`, { parse_mode: "Markdown" }); return;
      }
      if (pa.step === "delete_key") {
        delete pending[chatId]; const k = text.trim().toUpperCase();
        if (keys[k]) { delete keys[k]; logActivity(chatId, tgUser, "KEY_DELETED", k); await send(chatId, `✅ Silindi: \`${k}\``, { parse_mode: "Markdown" }); }
        else { await send(chatId, "❌ Bulunamadı."); }
        return;
      }
      if (pa.step === "announce") {
        delete pending[chatId];
        if (text.toLowerCase() === "sil") { announcement = ""; logActivity(chatId, tgUser, "ANNOUNCE_CLEAR"); await send(chatId, "📢 Silindi."); }
        else { announcement = text; logActivity(chatId, tgUser, "ANNOUNCE_SET", text.slice(0, 80)); await send(chatId, `📢 ${text}`); }
        return;
      }
      if (pa.step === "ban_id") { pending[chatId] = { step: "ban_reason", targetId: text.trim() }; await send(chatId, "📝 Sebep:"); return; }
      if (pa.step === "ban_reason") {
        const tid = pa.targetId; delete pending[chatId];
        bannedUsers[tid] = { reason: text, bannedAt: new Date().toISOString(), bannedBy: tgUser };
        if (sessions[tid]) { sessions[tid].authed = false; sessions[tid].rank = null; }
        logActivity(chatId, tgUser, "BAN", `${tid} — ${text}`);
        await send(chatId, `🚫 Ban: \`${tid}\``, { parse_mode: "Markdown" }); return;
      }
      if (pa.step === "unban_id") {
        delete pending[chatId]; const tid = text.trim();
        if (bannedUsers[tid]) { delete bannedUsers[tid]; logActivity(chatId, tgUser, "UNBAN", tid); await send(chatId, `✅ Unban: \`${tid}\``, { parse_mode: "Markdown" }); }
        else { await send(chatId, "❌ Banlı değil."); }
        return;
      }
    }

    // CATCH-ALL
    if (text.startsWith("/")) {
      await send(chatId, "📌 /help ile komutları gör.");
      return;
    }
  }
});

// ═══════════════════════════════════════════════════════════════
//  HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════

async function showRegisterLogin(chatId, from) {
  const tgName = from.first_name || from.username || "?";
  const custom = welcomeMsg || `👋 Hoş geldin, *${tgName}*!\n\nDevam etmek için:`;
  await send(chatId,
    `┌──────────────────────────────┐\n` +
    `│        🌐  *NEXUS HUB*          │\n` +
    `│      Key Management          │\n` +
    `└──────────────────────────────┘\n\n` +
    custom,
    { parse_mode: "Markdown", reply_markup: JSON.stringify({ inline_keyboard: [[{ text: "📝 Kayıt Ol", callback_data: "self_register" }, { text: "🔑 Giriş Yap", callback_data: "self_login" }]] }) });
}

function doLogin(chatId, uname, pw, session, from, tgUser) {
  if (isLocked(session)) { return { msg: `🔒 Hesap kilitli. ${Math.ceil((session.lockedUntil - Date.now()) / 60000)}dk` }; }
  let foundUser = null;
  for (const [, u] of Object.entries(users)) {
    if (u.username && u.username.toLowerCase() === uname.toLowerCase()) { foundUser = u; break; }
  }
  if (!foundUser || foundUser.password !== pw) {
    session.loginAttempts++;
    const rem = MAX_LOGIN_ATTEMPTS - session.loginAttempts;
    logSecurity(chatId, tgUser, "FAILED_LOGIN", `${uname} | ${session.loginAttempts}/${MAX_LOGIN_ATTEMPTS}`);
    if (session.loginAttempts >= MAX_LOGIN_ATTEMPTS) {
      session.lockedUntil = Date.now() + LOCKOUT_MINUTES * 60000;
      logSecurity(chatId, tgUser, "BRUTE_FORCE", `${MAX_LOGIN_ATTEMPTS} deneme — kilitlendi`);
      return { msg: `🚨 ${LOCKOUT_MINUTES}dk kilitlendi!` };
    }
    return { msg: `❌ Yanlış. ${rem} hak kaldı.` };
  }

  // Suspicious login: IP changed
  const oldIp = session.lastIp;
  if (oldIp && oldIp !== "?" && session.lastIp !== oldIp) {
    logSecurity(chatId, tgUser, "SUSPICIOUS_LOGIN", `IP değişti: ${oldIp} → ${session.lastIp}`);
  }

  session.authed = true; session.rank = foundUser.rank; session.loginAttempts = 0; session.lockedUntil = 0;
  session.loginTime = new Date().toISOString(); session.tgUsername = from.username || null; session.tgFirstName = from.first_name || null; session.tgUserId = from.id;
  touchSession(session);
  logActivity(chatId, tgUser, "LOGIN_OK", `${uname} | ${foundUser.rank}`);
  return { msg: `✅ *${uname}* — giriş OK.\n🎖 ${foundUser.rank}\n\n/menu` };
}

function doRegister(chatId, uname, pw, session, from, tgUser) {
  if (uname.length < 3 || uname.length > 20) return { msg: "❌ Ad 3-20 karakter." };
  if (pw.length < 4) return { msg: "❌ Şifre min 4 karakter." };
  if (!/^[a-zA-Z0-9_]+$/.test(uname)) return { msg: "❌ Sadece harf/rakam/_" };
  if (users[chatId] && users[chatId].username) return { msg: `❌ Zaten kayıtlı: *${users[chatId].username}*` };
  for (const u of Object.values(users)) { if (u.username && u.username.toLowerCase() === uname.toLowerCase()) return { msg: "❌ Ad alınmış." }; }

  const existingPhone = users[chatId] && users[chatId].phone ? users[chatId].phone : null;
  users[chatId] = { username: uname, password: pw, rank: "USER", phone: existingPhone, tgUsername: from.username || null, tgUserId: from.id, createdAt: new Date().toISOString(), createdBy: "SELF" };
  session.authed = true; session.rank = "USER"; session.loginAttempts = 0; session.loginTime = new Date().toISOString();
  session.tgUsername = from.username || null; session.tgFirstName = from.first_name || null; session.tgUserId = from.id;
  touchSession(session);
  logActivity(chatId, tgUser, "SELF_REGISTER", uname);
  logSecurity(chatId, tgUser, "NEW_REGISTER", uname);
  send(ADMIN_ID, `📝 *Yeni Kayıt*\n\n👤 ${uname}\n🆔 \`${chatId}\`\n📞 \`${existingPhone ? "+" + existingPhone : "yok"}\`\n@${tgUser}`, { parse_mode: "Markdown" });
  return { msg: `✅ *${uname}* — kayıt OK!\n\n/menu` };
}

// ═══════════════════════════════════════════════════════════════
//  DELTA BYPASS (extracted for clarity)
// ═══════════════════════════════════════════════════════════════
async function handleDeltaBypass(chatId, tgUser, link) {
  let bypassUrl = null, deltaKey = null, linkType = null;

  const junkPatterns = [/discord\.gg/i, /discord\.com/i, /join here/i, /patreon/i, /donate/i, /premium/i, /subscribe/i, /t\.me\//i, /free api/i, /working bypass/i, /join.*?server/i, /click.*?here/i, /buy.*?premium/i, /giveaway/i];
  function isJunk(str) { if (!str || str.length > 600 || !str.startsWith("http")) return true; return junkPatterns.some(p => p.test(str)); }
  const blockedDomains = ["lootlabs", "lootdest", "loot-link", "platorelay", "linkvertise", "link-to", "direct-link", "link-center", "socialwolvez", "sub2get", "google.com", "facebook.com", "twitter.com", "youtube.com"];
  function isBlockedDomain(url) { try { const h = new URL(url).hostname.toLowerCase(); return blockedDomains.some(d => h.includes(d)); } catch { return false; } }
  function extractDeltaKey(url) {
    try {
      const u = new URL(url);
      if (u.hostname.includes("platoboost") || u.hostname.includes("gateway")) {
        const k = u.searchParams.get("key") || u.searchParams.get("token") || u.searchParams.get("tk");
        if (k && k.length >= 8) return k;
      }
      for (const p of ["key", "token", "code", "tk", "k"]) { const v = u.searchParams.get(p); if (v && v.length >= 8 && /^[A-Za-z0-9_\-]+$/.test(v)) return v; }
      if (u.hash && u.hash.length > 8) { const h = u.hash.replace("#", ""); if (/^[A-Za-z0-9_\-]+$/.test(h) && h.length >= 8) return h; }
    } catch {}
    return null;
  }

  try { const u = new URL(link); const h = u.hostname.replace("www.", "").toLowerCase(); linkType = h.includes("linkvertise") ? "linkvertise" : h.includes("loot") ? "lootlabs" : h.includes("platoboost") || h.includes("gateway") ? "platoboost" : "other"; }
  catch { await send(chatId, "❌ Geçersiz link."); return; }

  await send(chatId, "⏳ Bypass çalışıyor...");

  if (linkType === "platoboost") deltaKey = extractDeltaKey(link);

  if (!deltaKey) {
    const T = 8000;
    const scrapeMethod = async () => {
      const r = await fetch(link, { redirect: "follow", headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36", Accept: "text/html,*/*;q=0.8", Referer: "https://www.google.com/" }, signal: AbortSignal.timeout(T) });
      const html = await r.text();
      const pats = [/["']destination["']\s*[:=]\s*["'](https?:\/\/[^"']+)["']/i, /["']targetUrl["']\s*[:=]\s*["'](https?:\/\/[^"']+)["']/i, /window\.location(?:\.href)?\s*=\s*["'](https?:\/\/[^"']+)["']/i, /redirect(?:Url|_url)\s*[:=]\s*["'](https?:\/\/[^"']+)["']/i, /href\s*=\s*["'](https?:\/\/gateway\.platoboost[^"']+)["']/i];
      for (const pat of pats) { const m = html.match(pat); if (m && m[1] && !isBlockedDomain(m[1]) && !isJunk(m[1])) { const k = extractDeltaKey(m[1]); return k ? { key: k } : { url: m[1] }; } }
      const kPats = [/platoboost[^"']*\?[^"']*key=([A-Za-z0-9_\-]{8,64})/i, /["']?key["']?\s*[:=]\s*["']([A-Za-z0-9_\-]{8,64})["']/];
      for (const pat of kPats) { const m = html.match(pat); if (m && m[1]) return { key: m[1] }; }
      if (r.url !== link && !isBlockedDomain(r.url) && !isJunk(r.url)) { const k = extractDeltaKey(r.url); return k ? { key: k } : { url: r.url }; }
      return null;
    };
    const apiMethod = async (apiUrl) => {
      const r = await fetch(apiUrl, { headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" }, signal: AbortSignal.timeout(T) });
      if (!r.ok) return null;
      try { const d = await r.json(); const result = d.destination || d.result || d.bypassed || d.url || d.target || d.dest || d.direct || d.resolved || d.link || null; if (typeof result !== "string") return null; if (!isJunk(result) && !isBlockedDomain(result)) { const k = extractDeltaKey(result); return k ? { key: k } : { url: result }; } } catch {}
      return null;
    };
    const enc = encodeURIComponent(link);
    const methods = [
      scrapeMethod().catch(() => null),
      apiMethod(`https://bypass.bot.nu/bypass2?url=${enc}`).catch(() => null),
      apiMethod(`https://api.bypass.vip/bypass?url=${enc}`).catch(() => null),
    ];
    const BYPASS_API_KEY = process.env.BYPASS_API_KEY || "";
    if (BYPASS_API_KEY) {
      methods.push((async () => {
        const r = await fetch("https://bypass-links.com/api/v1/bypass", { method: "POST", headers: { "x-api-key": BYPASS_API_KEY, "Content-Type": "application/json" }, body: JSON.stringify({ url: link }), signal: AbortSignal.timeout(T) });
        if (!r.ok) return null; const d = await r.json(); if (d.success && d.direct && !isJunk(d.direct) && !isBlockedDomain(d.direct)) { const k = extractDeltaKey(d.direct); return k ? { key: k } : { url: d.direct }; } return null;
      })().catch(() => null));
    }

    const raceResult = await new Promise((resolve) => {
      let settled = false, done = 0;
      for (const p of methods) { p.then(r => { if (!settled && r && (r.key || r.url)) { settled = true; resolve(r); } done++; if (done >= methods.length && !settled) { settled = true; resolve(null); } }); }
      setTimeout(() => { if (!settled) { settled = true; resolve(null); } }, 12000);
    });
    if (raceResult) { if (raceResult.key) deltaKey = raceResult.key; else if (raceResult.url) bypassUrl = raceResult.url; }
  }

  if (bypassUrl && !deltaKey) { const k = extractDeltaKey(bypassUrl); if (k) { deltaKey = k; bypassUrl = null; } }

  logActivity(chatId, tgUser, "DELTA_BYPASS", `${linkType} | ${deltaKey ? "KEY" : bypassUrl ? "URL" : "FAIL"}`);
  if (deltaKey) { await send(chatId, `✅ *Delta Key:*\n\n🔑 \`${deltaKey}\`\n\n📋 Kopyala.`, { parse_mode: "Markdown" }); }
  else if (bypassUrl) { const pk = extractDeltaKey(bypassUrl); if (pk) { await send(chatId, `✅ *Delta Key:*\n\n🔑 \`${pk}\``, { parse_mode: "Markdown" }); } else { await send(chatId, `✅ *Bypass OK*\n\n🔗 \`${bypassUrl}\``, { parse_mode: "Markdown" }); } }
  else { await send(chatId, `❌ Bypass başarısız.\n\n🔄 /menu → Delta Bypass ile tekrar dene.`); }
}

// ═══════════════════════════════════════════════════════════════
//  API ENDPOINTS
// ═══════════════════════════════════════════════════════════════

// BACKUP API
const BACKUP_SECRET = process.env.BACKUP_SECRET || BOT_TOKEN;
app.get("/backup", (req, res) => {
  if (req.query.secret !== BACKUP_SECRET) return res.status(403).json({ error: "yetkisiz" });
  saveState(); res.json({ users, keys, bannedUsers, maintenance, announcement, userNotes, ipBlacklist, hwidBlacklist, referrals, savedAt: new Date().toISOString() });
});
app.post("/restore", express.json(), (req, res) => {
  if (req.query.secret !== BACKUP_SECRET) return res.status(403).json({ error: "yetkisiz" });
  const d = req.body;
  if (d.users) users = { ...users, ...d.users };
  if (d.keys) keys = { ...keys, ...d.keys };
  if (d.bannedUsers) bannedUsers = { ...bannedUsers, ...d.bannedUsers };
  if (d.maintenance !== undefined) maintenance = d.maintenance;
  if (d.announcement !== undefined) announcement = d.announcement;
  saveState(); res.json({ status: "ok", users: Object.keys(users).length, keys: Object.keys(keys).length });
});

// PING
app.get("/ping", (req, res) => {
  const ip2 = req.headers["x-forwarded-for"] || req.socket.remoteAddress || "?";
  if (!rateCheck(ip2, RATE_MAX_API)) return res.status(429).json({ status: "error", message: "rate limit" });
  res.json({ status: "ok", version: BOT_VERSION, maintenance, announcement, uptime: Math.floor((Date.now() - BOOT_TIME) / 1000), keys: Object.values(keys).filter(v => v.status === "ok").length, users: Object.keys(users).length });
});

// HEALTH
app.get("/health", (req, res) => {
  res.json({
    status: "ok", version: BOT_VERSION,
    uptime: Math.floor((Date.now() - BOOT_TIME) / 1000),
    memory: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
    users: Object.keys(users).length,
    keys: Object.keys(keys).length,
    activeSessions: Object.values(sessions).filter(s => s.authed && !isSessionExpired(s)).length,
    maintenance,
  });
});

// CHECK KEY
app.get("/check", (req, res) => {
  const ip2 = req.headers["x-forwarded-for"] || req.socket.remoteAddress || "?";
  if (!rateCheck(ip2, RATE_MAX_API)) { logSecurity("API", ip2, "RATE_LIMIT", "API flood"); return res.status(429).json({ status: "error", message: "rate limit" }); }

  // IP blacklist
  if (ipBlacklist[ip2]) { logSecurity("API", ip2, "IP_BLOCKED", "kara liste"); return res.status(403).json({ status: "blocked", message: "erişim engellendi" }); }

  const key = (req.query.key || "").trim().toUpperCase();
  if (!key) return res.json({ status: "error", message: "key yok" });
  if (!/^NEXUS-(DAY|WEEK|MONTH|PERM)-[A-F0-9]{6}$/.test(key)) { logSecurity("API", ip2, "MALFORMED_KEY", key.slice(0, 20)); return res.json({ status: "invalid", message: "geçersiz format" }); }

  const entry = keys[key];
  if (!entry) { logSecurity("API", ip2, "INVALID_KEY", key.slice(0, 16)); return res.json({ status: "invalid" }); }
  if (entry.status === "revoked") { return res.json({ status: "revoked", message: "key iptal edildi" }); }
  if (entry.paused) { return res.json({ status: "paused", message: "key duraklatıldı" }); }
  if (entry.expire && Date.now() > entry.expire) { entry.status = "expired"; return res.json({ status: "expired" }); }

  // HWID check
  const ua = req.headers["user-agent"] || "?";
  const hwid = (req.query.hwid || req.headers["x-hwid"] || "").trim().slice(0, 64);

  // HWID blacklist
  if (hwid && hwidBlacklist[hwid]) { logSecurity("API", ip2, "HWID_BLOCKED", `${hwid.slice(0, 20)}`); return res.status(403).json({ status: "blocked", message: "cihaz engellendi" }); }

  const deviceId = hwid || ip2;
  if (!entry.devices) entry.devices = [];
  const existing = entry.devices.find(d => d.id === deviceId);
  if (existing) { existing.lastSeen = new Date().toISOString(); existing.ip = ip2; existing.ua = ua; existing.uses = (existing.uses || 0) + 1; }
  else {
    const maxDev = entry.maxDevices || 1;
    if (entry.devices.length >= maxDev) {
      logSecurity("API", ip2, "DEVICE_LIMIT", `${key} | ${entry.devices.length}/${maxDev}`);
      return res.json({ status: "device_limit", message: `max ${maxDev} cihaz` });
    }
    entry.devices.push({ id: deviceId, ip: ip2, hwid: hwid || null, ua, firstSeen: new Date().toISOString(), lastSeen: new Date().toISOString(), uses: 1 });
  }
  entry.totalUses = (entry.totalUses || 0) + 1;
  entry.lastUsed = new Date().toISOString();

  logActivity("API", ip2, "KEY_OK", `${key} | ${entry.rank} | ${entry.game} | dev:${deviceId.slice(0, 16)}`);
  res.json({ status: "ok", rank: entry.rank, game: entry.game, expire: entry.expire || null });
});

// 404
app.use((req, res) => {
  const ip2 = req.headers["x-forwarded-for"] || req.socket.remoteAddress || "?";
  logSecurity("HTTP", ip2, "UNKNOWN_ROUTE", `${req.method} ${req.path}`);
  res.status(404).json({ error: "bulunamadı" });
});

// ═══════════════════════════════════════════════════════════════
//  STARTUP
// ═══════════════════════════════════════════════════════════════
async function setupWebhook() {
  const url = `https://nexus-hub-b3gl.onrender.com/webhook/${BOT_TOKEN}`;
  try {
    const r = await fetch(`${API}/setWebhook`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url }) });
    const d = await r.json();
    console.log("Webhook:", d.ok ? "SET" : d.description);
  } catch (e) { console.error("Webhook:", e.message); }
}

// Auto-expire keys
setInterval(() => {
  const now = Date.now();
  for (const [, v] of Object.entries(keys)) if (v.expire && now > v.expire) v.status = "expired";
}, 600000);

// Auto-cleanup expired sessions (every 30min)
setInterval(() => {
  const now = Date.now();
  for (const [id, s] of Object.entries(sessions)) {
    if (s.lastActivity && now - s.lastActivity > SESSION_TIMEOUT_MINUTES * 60000 * 2) {
      delete sessions[id];
    }
  }
}, 1800000);

// Get bot username for invite links
let botUsername = "";
async function getBotInfo() {
  try {
    const r = await fetch(`${API}/getMe`);
    const d = await r.json();
    if (d.ok) botUsername = d.result.username;
  } catch {}
}

app.listen(PORT, () => {
  console.log(`NEXUS HUB v${BOT_VERSION} :${PORT}`);
  setupWebhook();
  getBotInfo();
});
