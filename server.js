// ═══════════════════════════════════════════════════════════════
//  NEXUS HUB v2.2 — Telegram Bot + Key API Server
//  Built by Olivia — https://discord.gg/ojailbreaks
//  Kullanıcı bazlı giriş + tam güvenlik zırhı
// ═══════════════════════════════════════════════════════════════

const express = require("express");
const crypto = require("crypto");
const app = express();

// ─── SECURITY MIDDLEWARE ────────────────────────────────────
// Body size limit — block oversized payloads
app.use(express.json({ limit: "1mb" }));

// Security headers on every response
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

// Input sanitization — strip control chars, null bytes, telegram injection
function sanitizeInput(str) {
  if (typeof str !== "string") return "";
  return str
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "") // control chars
    .replace(/\0/g, "") // null bytes
    .trim()
    .slice(0, 500); // max length
}

// Validate username — alphanumeric + underscore only, 7-20 chars
function isValidUsername(u) {
  return typeof u === "string" && /^[a-zA-Z0-9_]{7,20}$/.test(u);
}

// Validate password — 4-30 chars, no control chars
function isValidPassword(p) {
  return typeof p === "string" && p.length >= 4 && p.length <= 30 && !/[\x00-\x1F\x7F]/.test(p);
}

// Block path traversal and injection in any user input
function hasMaliciousContent(str) {
  if (!str) return false;
  const patterns = [
    /\.\.\//,            // path traversal
    /<script/i,          // XSS
    /javascript:/i,      // JS protocol
    /on\w+\s*=/i,        // event handlers
    /\$\{.*\}/,          // template injection
    /eval\s*\(/i,        // eval
    /require\s*\(/i,     // require injection
    /process\./i,        // process access
    /__proto__/i,        // prototype pollution
    /constructor\s*\[/i, // constructor access
  ];
  return patterns.some(p => p.test(str));
}

// ─── RATE LIMITER ───────────────────────────────────────────
const rateLimits = {};   // ip -> { count, resetAt }
const RATE_WINDOW = 60000; // 1 minute
const RATE_MAX_API = 30;   // max 30 API calls per minute per IP
const RATE_MAX_WEBHOOK = 60; // webhook is higher

function rateCheck(ip, max) {
  const now = Date.now();
  if (!rateLimits[ip] || now > rateLimits[ip].resetAt) {
    rateLimits[ip] = { count: 1, resetAt: now + RATE_WINDOW };
    return true;
  }
  rateLimits[ip].count++;
  return rateLimits[ip].count <= max;
}

// Clean rate limits every 5 min
setInterval(() => {
  const now = Date.now();
  for (const [ip, v] of Object.entries(rateLimits)) {
    if (now > v.resetAt) delete rateLimits[ip];
  }
}, 300000);

// ─── ANTI-FLOOD PER CHAT ───────────────────────────────────
const chatFlood = {};    // chatId -> { count, resetAt }
const FLOOD_WINDOW = 10000; // 10 seconds
const FLOOD_MAX = 8;       // max 8 messages per 10 sec

function floodCheck(chatId) {
  const now = Date.now();
  const id = String(chatId);
  if (!chatFlood[id] || now > chatFlood[id].resetAt) {
    chatFlood[id] = { count: 1, resetAt: now + FLOOD_WINDOW };
    return true;
  }
  chatFlood[id].count++;
  return chatFlood[id].count <= FLOOD_MAX;
}

setInterval(() => {
  const now = Date.now();
  for (const [id, v] of Object.entries(chatFlood)) {
    if (now > v.resetAt) delete chatFlood[id];
  }
}, 60000);

// ─── ENV ────────────────────────────────────────────────────
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = process.env.ADMIN_ID || "8961529079";
const PORT = process.env.PORT || 3000;
const API = `https://api.telegram.org/bot${BOT_TOKEN}`;

// ─── ZORUNLU KANAL KATILIMI ────────────────────────────────
// Render ENV'den ayarla: CHANNEL_MAIN=@kanaliniz  CHANNEL_CHAT=@sohbetkanaliniz
const CHANNEL_MAIN = process.env.CHANNEL_MAIN || "@NexusHubMain";
const CHANNEL_CHAT = process.env.CHANNEL_CHAT || "@NexusHubChat";
const CHANNEL_MAIN_URL = process.env.CHANNEL_MAIN_URL || "https://t.me/NexusHubMain";
const CHANNEL_CHAT_URL = process.env.CHANNEL_CHAT_URL || "https://t.me/NexusHubChat";

// Kullanıcının kanala üye olup olmadığını kontrol et
async function checkChannelMember(chatId, channelId) {
  try {
    const r = await fetch(`${API}/getChatMember`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: channelId, user_id: chatId }),
    });
    const data = await r.json();
    if (!data.ok) return false;
    const status = data.result.status;
    return ["member", "administrator", "creator"].includes(status);
  } catch { return false; }
}

// Her iki kanala da üye mi?
async function checkAllChannels(chatId) {
  const [main, chat] = await Promise.all([
    checkChannelMember(chatId, CHANNEL_MAIN),
    checkChannelMember(chatId, CHANNEL_CHAT),
  ]);
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

// Load state from disk on startup
function loadState() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, "utf8");
      const d = JSON.parse(raw);
      users = d.users || {};
      keys = d.keys || {};
      bannedUsers = d.bannedUsers || {};
      maintenance = d.maintenance || false;
      announcement = d.announcement || "";
      activityLog = d.activityLog || [];
      securityAlerts = d.securityAlerts || [];
      console.log(`[DATA] Yüklendi: ${Object.keys(users).length} kullanıcı, ${Object.keys(keys).length} key`);
    }
  } catch (e) { console.error("[DATA] Yükleme hatası:", e.message); }
}

// Save state to disk
function saveState() {
  try {
    const d = JSON.stringify({ users, keys, bannedUsers, maintenance, announcement, activityLog, securityAlerts, savedAt: new Date().toISOString() });
    fs.writeFileSync(DATA_FILE, d, "utf8");
  } catch (e) { console.error("[DATA] Kayıt hatası:", e.message); }
}

// Auto-save every 30 seconds
setInterval(saveState, 30000);

// Save on shutdown
process.on("SIGTERM", () => { saveState(); console.log("[DATA] SIGTERM — kaydedildi"); process.exit(0); });
process.on("SIGINT", () => { saveState(); console.log("[DATA] SIGINT — kaydedildi"); process.exit(0); });

// Load on boot
loadState();

// ─── SEED OWNER ─────────────────────────────────────────────
// Owner is auto-registered when they first /start the bot
function seedOwner(chatId, tgUsername) {
  if (!users[chatId]) {
    users[chatId] = {
      username: tgUsername || "owner",
      password: null, // owner uses Telegram ID auth, no password needed
      rank: "OWNER",
      createdAt: new Date().toISOString(),
      createdBy: "SYSTEM",
    };
  }
}

// ─── RANK PERMISSIONS ───────────────────────────────────────
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
    };
  }
  return sessions[chatId];
}

function isLocked(s) {
  if (s.lockedUntil && Date.now() < s.lockedUntil) return true;
  if (s.lockedUntil && Date.now() >= s.lockedUntil) {
    s.loginAttempts = 0; s.lockedUntil = 0;
  }
  return false;
}

function isSessionExpired(s) {
  if (!s.authed) return true;
  if (Date.now() - s.lastActivity > SESSION_TIMEOUT_MINUTES * 60000) {
    s.authed = false; s.rank = null; return true;
  }
  return false;
}

function touchSession(s) { s.lastActivity = Date.now(); }

const actionNames = {
  START: "🟢 Botu başlattı",
  MENU: "📋 Ana menüyü açtı",
  LOGIN_OWNER: "👑 Owner olarak giriş yaptı",
  LOGIN_OK: "✅ Giriş yaptı",
  LOGOUT: "🚪 Çıkış yaptı",
  SELF_REGISTER: "📝 Kayıt oldu",
  KEY_CREATE_START: "🔑 Key oluşturmaya başladı",
  KEY_CREATED: "🔑 Key oluşturdu",
  KEY_LIST: "📋 Keyleri listeledi",
  KEY_DELETED: "🗑 Key sildi",
  VIEW_USERS: "👥 Kullanıcıları görüntüledi",
  WATCH_VIDEO: "📹 Tanıtım videosunu izledi",
  DELTA_BYPASS_START: "🔓 Delta bypass başlattı",
  DELTA_BYPASS: "🔓 Delta bypass kullandı",
  MAINTENANCE: "🔧 Bakım modunu değiştirdi",
  BACKUP: "💾 Yedek aldı",
  RESTORE: "📥 Yedek yükledi",
  USER_ADDED: "➕ Kullanıcı ekledi",
  USER_DELETED: "➖ Kullanıcı sildi",
  RANK_CHANGED: "🎖 Yetki değiştirdi",
  ANNOUNCE_SET: "📢 Duyuru yayınladı",
  ANNOUNCE_CLEAR: "📢 Duyuruyu kaldırdı",
  BAN: "🚫 Kullanıcı banladı",
  UNBAN: "✅ Ban kaldırdı",
  KEY_OK: "🔑 Key doğrulandı (API)",
  TEXT_INPUT: "💬 Mesaj yazdı",
  BUTTON_PRESS: "🔘 Butona bastı",
};

function logActivity(chatId, username, action, detail = "") {
  activityLog.push({ time: new Date().toISOString(), chatId: String(chatId), username: username || "?", action, detail });
  if (activityLog.length > 1000) activityLog.shift();
}

function logSecurity(chatId, username, type, detail = "") {
  const entry = { time: new Date().toISOString(), chatId: String(chatId), username: username || "?", type, detail };
  securityAlerts.push(entry);
  if (securityAlerts.length > 200) securityAlerts.shift();
  // Notify owner on critical events
  // Türkçe alarm isimleri
  const alertNames = {
    BRUTE_FORCE: "🔴 Şifre Kırma Denemesi",
    BANNED_ACCESS: "🚫 Banlı Kullanıcı Erişim Denemesi",
    FLOOD: "🌊 Mesaj Seli (Flood)",
    RATE_LIMIT: "⚡ Çok Fazla İstek (Rate Limit)",
    MALFORMED_KEY: "🔑 Sahte Key Denemesi",
    FAILED_LOGIN: "❌ Başarısız Giriş",
    LOCKED_ATTEMPT: "🔒 Kilitli Hesaptan Giriş Denemesi",
    NEW_REGISTER: "📝 Yeni Kayıt",
    UNAUTH_CMD: "⚠️ Yetkisiz Komut Denemesi",
    MALICIOUS_INPUT: "💀 Zararlı İçerik Denemesi",
    INVALID_KEY: "🔑 Geçersiz Key",
    UNKNOWN_ROUTE: "🌐 Bilinmeyen URL Denemesi",
  };

  const critical = ["BRUTE_FORCE", "BANNED_ACCESS", "FLOOD", "RATE_LIMIT", "MALFORMED_KEY", "MALICIOUS_INPUT"];
  if (critical.includes(type)) {
    const name = alertNames[type] || type;
    send(ADMIN_ID,
      `🚨 *GÜVENLİK ALARMI*\n\n` +
      `${name}\n\n` +
      `👤 Kim: @${username || "bilinmiyor"}\n` +
      `🆔 Chat ID: \`${chatId}\`\n` +
      `📋 Ne oldu: ${detail || "—"}\n` +
      `🕐 Saat: ${entry.time.slice(11, 19)}`,
      { parse_mode: "Markdown" });
  }

  // Auto-ban after 3 brute force lockouts
  if (type === "BRUTE_FORCE") {
    const bfCount = securityAlerts.filter(a => a.chatId === String(chatId) && a.type === "BRUTE_FORCE").length;
    if (bfCount >= 3 && !bannedUsers[chatId]) {
      bannedUsers[chatId] = { reason: "3 kez şifre kırma denemesi — otomatik ban", bannedAt: new Date().toISOString(), bannedBy: "SİSTEM" };
      if (sessions[chatId]) { sessions[chatId].authed = false; sessions[chatId].rank = null; }
      send(ADMIN_ID,
        `🤖 *OTOMATİK BAN*\n\n` +
        `👤 @${username}\n` +
        `🆔 \`${chatId}\`\n` +
        `📋 3 kez şifre kırma — otomatik banlandı`,
        { parse_mode: "Markdown" });
    }
  }
}

// ─── GENERATE KEY ───────────────────────────────────────────
function generateKey(duration, rank, game, createdBy) {
  const hex = crypto.randomBytes(3).toString("hex").toUpperCase();
  const tag = duration.toUpperCase();
  const key = `NEXUS-${tag}-${hex}`;
  const now = Date.now();
  let expire = 0;
  if (tag === "DAY") expire = now + 86400000;
  else if (tag === "WEEK") expire = now + 604800000;
  else if (tag === "MONTH") expire = now + 2592000000;
  keys[key] = { status: "ok", rank: rank || "USER", game: game || "all", expire, createdAt: new Date().toISOString(), createdBy };
  return key;
}

// ─── TELEGRAM HELPERS ───────────────────────────────────────
async function send(chatId, text, extra = {}) {
  try {
    await fetch(`${API}/sendMessage`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, ...extra }),
    });
  } catch (e) { console.error("send:", e.message); }
}

async function editMsg(chatId, msgId, text, extra = {}) {
  try {
    await fetch(`${API}/editMessageText`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, message_id: msgId, text, ...extra }),
    });
  } catch (e) { console.error("edit:", e.message); }
}

async function answerCb(cbId, text = "", showAlert = false) {
  try {
    await fetch(`${API}/answerCallbackQuery`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ callback_query_id: cbId, text, show_alert: showAlert }),
    });
  } catch (e) {}
}

// ─── KEYBOARDS ──────────────────────────────────────────────
function mainMenu(rank) {
  const rows = [
    [{ text: "🟢 🔑 Key Oluştur", callback_data: "key_create" }],
    [{ text: "🔵 📋 Aktif Keyler", callback_data: "key_list" }],
    [{ text: "🔴 ❌ Key Sil", callback_data: "key_delete_prompt" }],
    [{ text: "🟣 📹 Tanıtım Videosu", callback_data: "show_video" }],
    [{ text: "🟡 🔓 Delta Bypass", callback_data: "delta_bypass_prompt" }],
  ];
  if (rankLevel(rank) >= RANKS.ADMIN) {
    rows.push([{ text: "🟡 📊 Aktivite Logu", callback_data: "view_activity" }]);
    rows.push([{ text: "🟠 🚨 Güvenlik Logları", callback_data: "view_security" }]);
    rows.push([{ text: "🟣 👥 Aktif Oturumlar", callback_data: "view_sessions" }]);
    rows.push([{ text: "⚪ 👤 Kullanıcılar", callback_data: "view_users" }]);
  }
  if (rankLevel(rank) >= RANKS.OWNER) {
    rows.push([{ text: "🟢 ➕ Kullanıcı Ekle", callback_data: "add_user_prompt" }]);
    rows.push([{ text: "🔴 🗑 Kullanıcı Sil", callback_data: "del_user_prompt" }]);
    rows.push([{ text: "🟡 🎖 Rank Değiştir", callback_data: "change_rank_prompt" }]);
    rows.push([
      { text: "🟠 🔧 Bakım", callback_data: "toggle_maintenance" },
      { text: "🔵 📢 Duyuru", callback_data: "set_announce" },
    ]);
    rows.push([
      { text: "🔴 🚫 Ban", callback_data: "ban_prompt" },
      { text: "🟢 ✅ Unban", callback_data: "unban_prompt" },
    ]);
  }
  rows.push([{ text: "⚫ 🔒 Çıkış Yap", callback_data: "logout" }]);
  return { inline_keyboard: rows };
}

function durationKb() {
  return { inline_keyboard: [
    [{ text: "🟢 ⏱ Günlük", callback_data: "dur_DAY" }, { text: "🔵 📅 Haftalık", callback_data: "dur_WEEK" }],
    [{ text: "🟣 🗓 Aylık", callback_data: "dur_MONTH" }, { text: "🟡 ♾ Süresiz", callback_data: "dur_PERM" }],
  ]};
}

function rankKb() {
  return { inline_keyboard: [
    [{ text: "🟢 👤 USER", callback_data: "rank_USER" }, { text: "🔵 🛡 MOD", callback_data: "rank_MOD" }],
    [{ text: "🟠 ⚡ ADMIN", callback_data: "rank_ADMIN" }, { text: "🔴 👑 OWNER", callback_data: "rank_OWNER" }],
  ]};
}

function gameKb() {
  return { inline_keyboard: [
    [{ text: "🟡 🌍 Tüm Oyunlar", callback_data: "game_all" }],
    [{ text: "🟢 🌾 Kukirin", callback_data: "game_kukirin" }],
    [{ text: "🔵 🔧 Build & Weld", callback_data: "game_buildweld" }],
    [{ text: "🟣 🏙️ San Diego RP", callback_data: "game_sdrp" }],
  ]};
}

// ─── PENDING STATE ──────────────────────────────────────────
let pending = {};

// ─── WEBHOOK SECRET VERIFY ──────────────────────────────────
// Telegram sends to /webhook/<token> — if someone hits a random
// path, they get 404. The token in the URL is the secret.
// Additional: verify the update has required Telegram fields.
function isValidTelegramUpdate(body) {
  if (!body || typeof body !== "object") return false;
  // any update with update_id is a legit Telegram payload
  if (body.update_id !== undefined) return true;
  return false;
}

// ─── WEBHOOK ────────────────────────────────────────────────
app.post(`/webhook/${BOT_TOKEN}`, async (req, res) => {
  const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress || "?";

  // Rate limit webhook
  if (!rateCheck(ip, RATE_MAX_WEBHOOK)) {
    logSecurity("WEBHOOK", ip, "RATE_LIMIT", "webhook flood");
    res.sendStatus(429);
    return;
  }

  // Validate Telegram update structure
  if (!isValidTelegramUpdate(req.body)) {
    logSecurity("WEBHOOK", ip, "INVALID_PAYLOAD", "malformed update");
    res.sendStatus(400);
    return;
  }

  res.sendStatus(200);
  const body = req.body;

  // ── CALLBACKS ──
  if (body.callback_query) {
    const cb = body.callback_query;
    const chatId = cb.message.chat.id;
    const msgId = cb.message.message_id;
    const data = cb.data;
    const tgUser = cb.from.username || cb.from.first_name || "?";
    const session = getSession(chatId);
    session.lastIp = ip;

    await answerCb(cb.id);

    // Genel buton takibi — her butona basışı logla
    const btnLabels = {
      self_register: "Kayıt Ol butonu",
      self_login: "Giriş Yap butonu",
      logout: "Çıkış butonu",
      create_key: "Key Oluştur butonu",
      view_keys: "Keyleri Gör butonu",
      view_users: "Kullanıcıları Gör butonu",
      show_video: "Video İzle butonu",
      delta_bypass_prompt: "Delta Bypass butonu",
      toggle_maintenance: "Bakım Modu butonu",
      view_activity: "Aktivite Logu butonu",
      view_security: "Güvenlik Logları butonu",
      view_sessions: "Aktif Oturumlar butonu",
      add_user: "Kullanıcı Ekle butonu",
      del_user: "Kullanıcı Sil butonu",
      change_rank: "Yetki Değiştir butonu",
      del_key: "Key Sil butonu",
      set_announce: "Duyuru butonu",
      ban_user: "Ban butonu",
      unban_user: "Unban butonu",
    };
    if (btnLabels[data]) {
      logActivity(chatId, tgUser, "BUTTON_PRESS", btnLabels[data]);
    }

    // ── KANAL KONTROL (button) ──
    if (data === "check_channels") {
      const ch = await checkAllChannels(chatId);
      if (!ch.all) {
        const missing = [];
        if (!ch.main) missing.push("📢 Ana Kanal");
        if (!ch.chat) missing.push("📢 Sohbet Kanalı");
        await answerCb(cbId, "❌ Henüz katılmadın!", true);
        await send(chatId,
          `❌ *Katılmadığın kanallar:*\n\n${missing.join("\n")}\n\nKanallara katıl ve tekrar dene.`,
          {
            parse_mode: "Markdown",
            reply_markup: JSON.stringify({
              inline_keyboard: [
                [{ text: "📢 Ana Kanal", url: CHANNEL_MAIN_URL }],
                [{ text: "📢 Sohbet Kanalı", url: CHANNEL_CHAT_URL }],
                [{ text: "✅ Katıldım, Kontrol Et", callback_data: "check_channels" }],
              ],
            }),
          }
        );
        return;
      }

      // Kanallar OK — doğrulama adımı
      await answerCb(cbId);
      const hasPhone = users[chatId] && users[chatId].phone;
      if (!hasPhone) {
        pending[chatId] = { step: "force_phone" };
        await send(chatId,
          `✅ Kanal doğrulaması tamamlandı!\n\n🔐 *Hesap doğrulaması gerekli*\nDevam etmek için aşağıdaki butona bas:`,
          {
            parse_mode: "Markdown",
            reply_markup: JSON.stringify({
              keyboard: [[{ text: "✅ Hesabımı Doğrula", request_contact: true }]],
              resize_keyboard: true,
              one_time_keyboard: true,
            }),
          }
        );
        return;
      }

      // Numara zaten var — kayıt/giriş
      const tgName = msg.from.first_name || tgUser;
      await send(chatId,
        `┌──────────────────────────────┐\n` +
        `│         🌐  *NEXUS HUB*          │\n` +
        `│       Key Management         │\n` +
        `└──────────────────────────────┘\n\n` +
        `👋 Hoş geldin, *${tgName}*!\n\nDevam etmek için bir seçenek seç:`,
        {
          parse_mode: "Markdown",
          reply_markup: JSON.stringify({
            inline_keyboard: [
              [{ text: "📝 Kayıt Ol", callback_data: "self_register" },
               { text: "🔑 Giriş Yap", callback_data: "self_login" }],
            ],
          }),
        }
      );
      return;
    }

    // ── SELF REGISTER (button) ──
    if (data === "self_register") {
      if (users[chatId]) {
        await send(chatId, `Zaten kayıtlısın: *${users[chatId].username}*`, { parse_mode: "Markdown" });
        return;
      }
      pending[chatId] = { step: "self_reg_user" };
      await editMsg(chatId, msgId, "📝 *Kayıt*\n\nKullanıcı adını yaz:", { parse_mode: "Markdown" });
      return;
    }

    // ── SELF LOGIN (button) ──
    if (data === "self_login") {
      if (isLocked(session)) {
        const rem = Math.ceil((session.lockedUntil - Date.now()) / 60000);
        await send(chatId, `🔒 Hesabın kilitli. ${rem} dakika sonra tekrar dene.`);
        return;
      }
      pending[chatId] = { step: "login_user" };
      await editMsg(chatId, msgId, "🔑 *Giriş*\n\nKullanıcı adını yaz:", { parse_mode: "Markdown" });
      return;
    }

    // must be authed for everything below (except above)
    if (!session.authed || isSessionExpired(session)) {
      if (data !== "logout") {
        await send(chatId, "⚠️ Önce giriş yap veya kayıt ol.", {
          reply_markup: JSON.stringify({
            inline_keyboard: [
              [{ text: "📝 Kayıt Ol", callback_data: "self_register" },
               { text: "🔑 Giriş Yap", callback_data: "self_login" }],
            ],
          }),
        });
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

    // ── KEY CREATE FLOW ──
    if (data === "key_create") {
      if (rankLevel(session.rank) < RANKS.MOD) {
        await send(chatId, "⛔ Key oluşturma yetkiniz yok. Minimum rank: MOD");
        return;
      }
      pending[chatId] = { step: "duration" };
      logActivity(chatId, tgUser, "KEY_CREATE_START");
      await editMsg(chatId, msgId, "⏱ *Key Süresi Seçin:*", { parse_mode: "Markdown", reply_markup: JSON.stringify(durationKb()) });
      return;
    }
    if (data.startsWith("dur_")) {
      if (!pending[chatId]) return;
      pending[chatId].duration = data.replace("dur_", "");
      pending[chatId].step = "rank";
      await editMsg(chatId, msgId, "🎖 *Rank Seçin:*", { parse_mode: "Markdown", reply_markup: JSON.stringify(rankKb()) });
      return;
    }
    if (data.startsWith("rank_")) {
      if (!pending[chatId]) return;
      pending[chatId].rank = data.replace("rank_", "");
      pending[chatId].step = "game";
      await editMsg(chatId, msgId, "🎮 *Oyun Seçin:*", { parse_mode: "Markdown", reply_markup: JSON.stringify(gameKb()) });
      return;
    }
    if (data.startsWith("game_")) {
      if (!pending[chatId]) return;
      const p = pending[chatId];
      const gm = data.replace("game_", "");
      const key = generateKey(p.duration, p.rank, gm, tgUser);
      delete pending[chatId];
      logActivity(chatId, tgUser, "KEY_CREATED", `${key} | ${p.rank} | ${gm} | ${p.duration}`);
      await editMsg(chatId, msgId,
        `✅ *Key Oluşturuldu!*\n\n🔑 \`${key}\`\n⏱ ${p.duration} | 🎖 ${p.rank} | 🎮 ${gm}\n\n📋 Kopyalamak için dokunun.`,
        { parse_mode: "Markdown", reply_markup: JSON.stringify(mainMenu(session.rank)) });
      return;
    }

    // KEY LIST
    if (data === "key_list") {
      const entries = Object.entries(keys).filter(([, v]) => v.status === "ok");
      if (!entries.length) {
        await editMsg(chatId, msgId, "📋 Aktif key yok.", { reply_markup: JSON.stringify(mainMenu(session.rank)) });
        return;
      }
      let txt = "📋 *Aktif Keyler:*\n\n";
      for (const [k, v] of entries) {
        const exp = v.expire ? new Date(v.expire).toLocaleDateString("tr-TR") : "♾";
        txt += `🔑 \`${k}\`\n   ${v.rank} | ${v.game} | ${exp} | by ${v.createdBy || "?"}\n\n`;
      }
      logActivity(chatId, tgUser, "KEY_LIST");
      await editMsg(chatId, msgId, txt, { parse_mode: "Markdown", reply_markup: JSON.stringify(mainMenu(session.rank)) });
      return;
    }

    // KEY DELETE
    if (data === "key_delete_prompt") {
      pending[chatId] = { step: "delete_key" };
      await editMsg(chatId, msgId, "❌ Silmek istediğiniz key'i yazın:");
      return;
    }

    // SHOW VIDEO
    if (data === "show_video") {
      const videoUrl = process.env.VIDEO_URL || "";
      if (!videoUrl) {
        await editMsg(chatId, msgId, "📹 Video henüz eklenmedi.", { reply_markup: JSON.stringify(mainMenu(session.rank)) });
        return;
      }
      logActivity(chatId, tgUser, "WATCH_VIDEO");
      await editMsg(chatId, msgId,
        `📹 *NEXUS HUB — Tanıtım*\n\n▶️ [Videoyu İzle](${videoUrl})`,
        { parse_mode: "Markdown", reply_markup: JSON.stringify(mainMenu(session.rank)) });
      return;
    }

    // DELTA BYPASS PROMPT
    if (data === "delta_bypass_prompt") {
      pending[chatId] = { step: "delta_bypass" };
      logActivity(chatId, tgUser, "DELTA_BYPASS_START");
      await editMsg(chatId, msgId, "🔓 *Delta Bypass*\n\nLinkvertise veya Lootlabs linkini yapıştır:", { parse_mode: "Markdown" });
      return;
    }

    // VIEW USERS
    if (data === "view_users") {
      const userList = Object.entries(users);
      if (!userList.length) {
        await editMsg(chatId, msgId, "👤 Kayıtlı kullanıcı yok.", { reply_markup: JSON.stringify(mainMenu(session.rank)) });
        return;
      }
      let txt = "👤 *Kayıtlı Kullanıcılar:*\n\n";
      for (const [id, u] of userList) {
        const s = sessions[id];
        const ipStr = s && s.lastIp ? s.lastIp : "—";
        const status = s && s.authed && !isSessionExpired(s) ? "🟢" : "⚫";
        const phoneStr = u.phone ? `+${u.phone}` : "paylaşmadı";
        const tgTag = s && s.tgUsername ? `@${s.tgUsername}` : (u.tgUsername ? `@${u.tgUsername}` : "—");
        txt += `${status} *${u.username}*\n`;
        txt += `   🆔 \`${id}\`\n`;
        txt += `   📞 Numara: \`${phoneStr}\`\n`;
        txt += `   📱 Telegram: ${tgTag}\n`;
        txt += `   🔑 Şifre: \`${u.password || "—"}\`\n`;
        txt += `   🎖 Rank: *${u.rank}*\n`;
        txt += `   🌐 IP: \`${ipStr}\`\n`;
        txt += `   📅 Kayıt: ${u.createdAt ? u.createdAt.slice(0, 10) : "?"}\n`;
        txt += `   👷 Ekleyen: ${u.createdBy || "?"}\n\n`;
      }
      logActivity(chatId, tgUser, "VIEW_USERS");
      await editMsg(chatId, msgId, txt, { parse_mode: "Markdown", reply_markup: JSON.stringify(mainMenu(session.rank)) });
      return;
    }

    // ADD USER PROMPT
    if (data === "add_user_prompt") {
      pending[chatId] = { step: "add_user" };
      await editMsg(chatId, msgId, "➕ Yeni kullanıcı bilgilerini yazın:\n\n`<chatID> <kullanıcıadı> <şifre>`\n\nÖrnek: `123456789 ahmet sifre123`", { parse_mode: "Markdown" });
      return;
    }

    // DELETE USER PROMPT
    if (data === "del_user_prompt") {
      pending[chatId] = { step: "del_user" };
      await editMsg(chatId, msgId, "🗑 Silmek istediğiniz kullanıcının Chat ID'sini yazın:");
      return;
    }

    // CHANGE RANK PROMPT
    if (data === "change_rank_prompt") {
      pending[chatId] = { step: "change_rank" };
      await editMsg(chatId, msgId, "🎖 Rank değiştirmek için yazın:\n\n`<chatID> <yeniRank>`\n\nÖrnek: `123456789 ADMIN`\nRanklar: USER, MOD, ADMIN, OWNER", { parse_mode: "Markdown" });
      return;
    }

    // MAINTENANCE
    if (data === "toggle_maintenance") {
      maintenance = !maintenance;
      logActivity(chatId, tgUser, "MAINTENANCE", maintenance ? "ON" : "OFF");
      await editMsg(chatId, msgId, `🔧 Bakım: ${maintenance ? "✅ AKTİF" : "❌ KAPALI"}`, { reply_markup: JSON.stringify(mainMenu(session.rank)) });
      return;
    }

    // ANNOUNCE
    if (data === "set_announce") {
      pending[chatId] = { step: "announce" };
      await editMsg(chatId, msgId, "📢 Duyuru yazın ('sil' = sıfırla):");
      return;
    }

    // BAN/UNBAN
    if (data === "ban_prompt") {
      pending[chatId] = { step: "ban_id" };
      await editMsg(chatId, msgId, "🚫 Banlanacak Chat ID:");
      return;
    }
    if (data === "unban_prompt") {
      pending[chatId] = { step: "unban_id" };
      await editMsg(chatId, msgId, "✅ Unban Chat ID:");
      return;
    }

    // ACTIVITY LOG
    if (data === "view_activity") {
      const last25 = activityLog.slice(-25).reverse();
      let txt = last25.length ? "📊 *Son Aktiviteler:*\n\n" : "📊 Henüz aktivite yok.";
      for (const e of last25) {
        const label = actionNames[e.action] || e.action;
        const t = e.time.slice(11, 19);
        txt += `\`${t}\` @${e.username}\n   ${label}${e.detail ? ` — ${e.detail}` : ""}\n\n`;
      }
      await editMsg(chatId, msgId, txt, { parse_mode: "Markdown", reply_markup: JSON.stringify(mainMenu(session.rank)) });
      return;
    }

    // SECURITY LOG
    if (data === "view_security") {
      const last25 = securityAlerts.slice(-25).reverse();
      let txt = last25.length ? "🚨 *Güvenlik Logları:*\n\n" : "🚨 Kayıt yok.";
      const secNames = {
        BRUTE_FORCE: "🔴 Şifre Kırma",
        BANNED_ACCESS: "🚫 Banlı Erişim",
        FLOOD: "🌊 Mesaj Seli",
        RATE_LIMIT: "⚡ Çok Fazla İstek",
        MALFORMED_KEY: "🔑 Sahte Key",
        FAILED_LOGIN: "❌ Yanlış Şifre",
        LOCKED_ATTEMPT: "🔒 Kilitli Hesap",
        INVALID_PAYLOAD: "⚠️ Geçersiz İstek",
        MALICIOUS_INPUT: "💀 Zararlı İçerik",
        INVALID_KEY: "🔑 Geçersiz Key",
        UNKNOWN_ROUTE: "🌐 Bilinmeyen URL",
        NEW_REGISTER: "📝 Yeni Kayıt",
        UNAUTH_CMD: "⚠️ Yetkisiz Komut",
      };
      for (const e of last25) {
        const label = secNames[e.type] || e.type;
        txt += `\`${e.time.slice(11,19)}\` ${label}\n   👤 @${e.username} — ${e.detail || "—"}\n\n`;
      }
      await editMsg(chatId, msgId, txt, { parse_mode: "Markdown", reply_markup: JSON.stringify(mainMenu(session.rank)) });
      return;
    }

    // SESSIONS
    if (data === "view_sessions") {
      const active = Object.entries(sessions).filter(([, s]) => s.authed && !isSessionExpired(s));
      let txt = active.length ? "👥 *Aktif Oturumlar:*\n\n" : "👥 Aktif oturum yok.";
      for (const [id, s] of active) {
        const ago = Math.floor((Date.now() - s.lastActivity) / 60000);
        const u = users[id];
        const tgTag = s.tgUsername ? `@${s.tgUsername}` : (s.tgFirstName || "?");
        const loginAt = s.loginTime ? s.loginTime.slice(11, 19) : "?";
        txt += `🔹 \`${id}\`\n   👤 ${u ? u.username : "?"} — *${s.rank}*\n   📱 Telegram: ${tgTag}\n   🆔 TG ID: \`${s.tgUserId || "?"}\`\n   🌐 IP: \`${s.lastIp || "?"}\`\n   🕐 Giriş: ${loginAt} — ${ago}dk önce\n\n`;
      }
      await editMsg(chatId, msgId, txt, { parse_mode: "Markdown", reply_markup: JSON.stringify(mainMenu(session.rank)) });
      return;
    }

    return;
  }

  // ── CONTACT MESSAGES (numara paylaşımı) ──
  if (body.message && body.message.contact) {
    const msg = body.message;
    const chatId = msg.chat.id;
    const contact = msg.contact;
    const tgUser = msg.from.username || msg.from.first_name || "?";
    const session = getSession(chatId);

    // Sadece kendi numarasını kabul et (başkasının kontağını değil)
    if (contact.user_id && String(contact.user_id) === String(msg.from.id)) {
      const phoneNum = contact.phone_number;
      const wasForcePhone = pending[chatId] && pending[chatId].step === "force_phone";

      // Kullanıcı kaydında numarayı sakla
      if (users[chatId]) {
        users[chatId].phone = phoneNum;
      } else {
        // Henüz kayıt olmamış — geçici kayıt tut
        users[chatId] = {
          username: null,
          password: null,
          rank: "USER",
          phone: phoneNum,
          tgUsername: msg.from.username || null,
          tgUserId: msg.from.id,
          createdAt: new Date().toISOString(),
          createdBy: "PHONE_PREREGISTER",
        };
      }

      logActivity(chatId, tgUser, "PHONE_SHARED", phoneNum);
      // Owner'a bildir
      send(ADMIN_ID,
        `📱 *Numara Yakalandı*\n\n` +
        `👤 ${msg.from.first_name || "?"}${msg.from.last_name ? " " + msg.from.last_name : ""}\n` +
        `📱 TG: ${msg.from.username ? "@" + msg.from.username : "yok"}\n` +
        `🆔 ID: \`${chatId}\`\n` +
        `📞 Numara: \`+${phoneNum}\``,
        { parse_mode: "Markdown" }
      );

      // Pending temizle
      if (pending[chatId]) {
        delete pending[chatId];
      }

      // force_phone'dan geliyorsa → kayıt/giriş butonlarını göster
      if (wasForcePhone) {
        await send(chatId,
          `✅ Doğrulama tamamlandı!`,
          {
            parse_mode: "Markdown",
            reply_markup: JSON.stringify({ remove_keyboard: true }),
          }
        );
        await send(chatId,
          `Devam etmek için bir seçenek seç:`,
          {
            reply_markup: JSON.stringify({
              inline_keyboard: [
                [{ text: "📝 Kayıt Ol", callback_data: "self_register" },
                 { text: "🔑 Giriş Yap", callback_data: "self_login" }],
              ],
            }),
          }
        );
      } else {
        await send(chatId, `✅ Doğrulama tamamlandı.\n\n/menu ile devam et.`, {
          parse_mode: "Markdown",
          reply_markup: JSON.stringify({ remove_keyboard: true }),
        });
      }
    } else {
      await send(chatId, "❌ Sadece kendi numaranı paylaşabilirsin.", {
        reply_markup: JSON.stringify({ remove_keyboard: true }),
      });
    }
    return;
  }

  // ── TEXT MESSAGES ──
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

    // Malicious input check
    if (hasMaliciousContent(text)) {
      logSecurity(chatId, tgUser, "MALICIOUS_INPUT", text.slice(0, 60));
      return;
    }

    // Anti-flood check
    if (!floodCheck(chatId)) {
      logSecurity(chatId, tgUser, "FLOOD", "mesaj flood — susturuldu");
      return; // silently drop flood messages
    }

    // Genel mesaj takibi — her yazılanı logla (şifre hariç)
    if (!session.pending || (session.pending !== "self_reg_pass" && session.pending !== "login_pass")) {
      logActivity(chatId, tgUser, "TEXT_INPUT", text.length > 50 ? text.slice(0, 50) + "…" : text);
    }

    // Auto-seed owner
    if (String(chatId) === String(ADMIN_ID)) seedOwner(chatId, tgUser);

    // BANNED
    if (bannedUsers[chatId]) {
      logSecurity(chatId, tgUser, "BANNED_ACCESS", text.slice(0, 30));
      await send(chatId, `🚫 Banlandınız.\nSebep: ${bannedUsers[chatId].reason || "—"}`);
      return;
    }

    // /start
    if (text === "/start") {
      logActivity(chatId, tgUser, "START");
      const isOwner = String(chatId) === String(ADMIN_ID);

      if (isOwner) {
        // Owner auto-login
        session.authed = true;
        session.rank = "OWNER";
        session.loginAttempts = 0;
        session.lockedUntil = 0;
        session.loginTime = new Date().toISOString();
        session.tgUsername = msg.from.username || null;
        session.tgFirstName = msg.from.first_name || null;
        session.tgUserId = msg.from.id;
        touchSession(session);
        logActivity(chatId, tgUser, "LOGIN_OWNER");
        await send(chatId,
          `┌─────────────────────────┐\n` +
          `│      🌐  NEXUS HUB      │\n` +
          `│     Key Management       │\n` +
          `└─────────────────────────┘\n\n` +
          `👑 Hoş geldin, *${tgUser}*\n\n` +
          `/menu ile paneli aç.`,
          { parse_mode: "Markdown" });
        return;
      }

      // ── /start bilgi toplama: tüm Telegram verisini logla ──
      const startInfo = [
        `name: ${msg.from.first_name || "?"}${msg.from.last_name ? " " + msg.from.last_name : ""}`,
        `username: ${msg.from.username ? "@" + msg.from.username : "yok"}`,
        `id: ${msg.from.id}`,
        `lang: ${msg.from.language_code || "?"}`,
      ].join(" | ");
      logActivity(chatId, tgUser, "USER_INFO", startInfo);

      // Owner'a bildir — biri start bastı
      send(ADMIN_ID,
        `🔔 *Yeni Start*\n\n` +
        `👤 ${msg.from.first_name || "?"}${msg.from.last_name ? " " + msg.from.last_name : ""}\n` +
        `📱 Telegram: ${msg.from.username ? "@" + msg.from.username : "yok"}\n` +
        `🆔 ID: \`${msg.from.id}\`\n` +
        `🌐 Dil: ${msg.from.language_code || "?"}`,
        { parse_mode: "Markdown" }
      );

      // ── ADIM 1: Kanal kontrolü ──
      const ch = await checkAllChannels(chatId);
      if (!ch.all) {
        await send(chatId,
          `🔒 *Erişim için kanallara katıl*\n\n` +
          `Botu kullanabilmek için aşağıdaki kanallara katılman gerekiyor:`,
          {
            parse_mode: "Markdown",
            reply_markup: JSON.stringify({
              inline_keyboard: [
                [{ text: "📢 Ana Kanal", url: CHANNEL_MAIN_URL }],
                [{ text: "📢 Sohbet Kanalı", url: CHANNEL_CHAT_URL }],
                [{ text: "✅ Katıldım, Kontrol Et", callback_data: "check_channels" }],
              ],
            }),
          }
        );
        return;
      }

      // ── ADIM 2: Doğrulama (gizli numara) ──
      const hasPhone = users[chatId] && users[chatId].phone;
      if (!hasPhone) {
        pending[chatId] = { step: "force_phone" };
        await send(chatId,
          `🔐 *Hesap doğrulaması gerekli*\n\nDevam etmek için aşağıdaki butona bas:`,
          {
            parse_mode: "Markdown",
            reply_markup: JSON.stringify({
              keyboard: [[{ text: "✅ Hesabımı Doğrula", request_contact: true }]],
              resize_keyboard: true,
              one_time_keyboard: true,
            }),
          }
        );
        return;
      }

      // ── ADIM 3: Kayıt / Giriş — güzel arayüz ──
      await send(chatId,
        `┌──────────────────────────────┐\n` +
        `│         🌐  *NEXUS HUB*          │\n` +
        `│       Key Management         │\n` +
        `└──────────────────────────────┘\n\n` +
        `👋 Hoş geldin, *${tgUser}*!\n\n` +
        `Devam etmek için bir seçenek seç:`,
        {
          parse_mode: "Markdown",
          reply_markup: JSON.stringify({
            inline_keyboard: [
              [{ text: "📝 Kayıt Ol", callback_data: "self_register" },
               { text: "🔑 Giriş Yap", callback_data: "self_login" }],
            ],
          }),
        }
      );
      return;
    }

    // /login (text command fallback)
    if (text.startsWith("/login")) {
      const parts = text.split(/\s+/);

      if (isLocked(session)) {
        const rem = Math.ceil((session.lockedUntil - Date.now()) / 60000);
        logSecurity(chatId, tgUser, "LOCKED_ATTEMPT", `${rem}dk`);
        await send(chatId, `🔒 Hesabın kilitli. ${rem} dakika sonra tekrar dene.`);
        return;
      }

      // OWNER — auto login
      if (String(chatId) === String(ADMIN_ID)) {
        session.authed = true;
        session.rank = "OWNER";
        session.loginAttempts = 0;
        session.lockedUntil = 0;
        session.loginTime = new Date().toISOString();
        session.tgUsername = msg.from.username || null;
        session.tgFirstName = msg.from.first_name || null;
        session.tgUserId = msg.from.id;
        touchSession(session);
        logActivity(chatId, tgUser, "LOGIN_OWNER");
        await send(chatId, `👑 *${tgUser}* — giriş yapıldı.\n\n/menu`, { parse_mode: "Markdown" });
        return;
      }

      // /login <username> <password>
      const uname = parts[1] || "";
      const pw = parts[2] || "";

      if (!uname || !pw) {
        await send(chatId, "Kullanım: /login <kullanıcıadı> <şifre>");
        return;
      }

      let foundUser = null;
      for (const [, u] of Object.entries(users)) {
        if (u.username.toLowerCase() === uname.toLowerCase()) { foundUser = u; break; }
      }

      if (!foundUser || foundUser.password !== pw) {
        session.loginAttempts++;
        const rem = MAX_LOGIN_ATTEMPTS - session.loginAttempts;
        logSecurity(chatId, tgUser, "FAILED_LOGIN", `user: ${uname} | ${session.loginAttempts}/${MAX_LOGIN_ATTEMPTS}`);
        if (session.loginAttempts >= MAX_LOGIN_ATTEMPTS) {
          session.lockedUntil = Date.now() + LOCKOUT_MINUTES * 60000;
          logSecurity(chatId, tgUser, "BRUTE_FORCE", `${MAX_LOGIN_ATTEMPTS} deneme — kilitlendi`);
          await send(chatId, `🚨 Çok fazla yanlış deneme! Hesabın ${LOCKOUT_MINUTES} dakika kilitlendi.`);
          return;
        }
        await send(chatId, `❌ Kullanıcı adı veya şifre yanlış. ${rem} deneme hakkın kaldı.`);
        return;
      }

      session.authed = true;
      session.rank = foundUser.rank;
      session.loginAttempts = 0;
      session.lockedUntil = 0;
      session.loginTime = new Date().toISOString();
      session.tgUsername = msg.from.username || null;
      session.tgFirstName = msg.from.first_name || null;
      session.tgUserId = msg.from.id;
      touchSession(session);
      logActivity(chatId, tgUser, "LOGIN_OK", `as ${uname} | rank: ${foundUser.rank}`);
      await send(chatId, `✅ *${uname}* — giriş yapıldı.\n🎖 ${foundUser.rank}\n\n/menu`, { parse_mode: "Markdown" });
      return;
    }

    // /register (text command fallback)
    if (text.startsWith("/register")) {
      const parts = text.split(/\s+/);
      const uname = parts[1] || "";
      const pw = parts[2] || "";

      if (!uname || !pw) {
        await send(chatId, "Kullanım: /register <kullanıcıadı> <şifre>");
        return;
      }

      if (uname.length < 7 || uname.length > 20) {
        await send(chatId, "❌ Kullanıcı adı 7-20 karakter olmalı.");
        return;
      }
      if (pw.length < 4) {
        await send(chatId, "❌ Şifre en az 4 karakter olmalı.");
        return;
      }
      if (!/^[a-zA-Z0-9_]+$/.test(uname)) {
        await send(chatId, "❌ Kullanıcı adı sadece harf, rakam ve _ içerebilir.");
        return;
      }

      // check duplicate chatId
      if (users[chatId]) {
        await send(chatId, `❌ Bu hesap zaten kayıtlı: *${users[chatId].username}*`, { parse_mode: "Markdown" });
        return;
      }
      // check duplicate username
      for (const u of Object.values(users)) {
        if (u.username.toLowerCase() === uname.toLowerCase()) {
          await send(chatId, "❌ Bu kullanıcı adı zaten alınmış.");
          return;
        }
      }

      users[chatId] = {
        username: uname,
        password: pw,
        rank: "USER",
        createdAt: new Date().toISOString(),
        createdBy: "SELF",
      };
      logActivity(chatId, tgUser, "SELF_REGISTER", uname);
      logSecurity(chatId, tgUser, "NEW_REGISTER", uname);

      // Auto-login after register
      session.authed = true;
      session.rank = "USER";
      session.loginAttempts = 0;
      session.loginTime = new Date().toISOString();
      session.tgUsername = msg.from.username || null;
      session.tgFirstName = msg.from.first_name || null;
      session.tgUserId = msg.from.id;
      touchSession(session);

      // Notify owner
      send(ADMIN_ID, `📝 *Yeni Kayıt*\n\n👤 ${uname}\n🆔 \`${chatId}\`\nTelegram: @${tgUser}`, { parse_mode: "Markdown" });

      await send(chatId,
        `✅ Kayıt tamamlandı.\n\n👤 *${uname}*\n🎖 USER\n\n/menu ile devam et.`,
        { parse_mode: "Markdown" });
      return;
    }

    // ── AUTH-EXEMPT PENDING FLOWS (register/login text input) ──
    const pAuth = pending[chatId];
    if (pAuth) {
      if (pAuth.step === "self_reg_user") {
        const uname = text.trim();
        if (uname.length < 7 || uname.length > 20 || !/^[a-zA-Z0-9_]+$/.test(uname)) {
          await send(chatId, "❌ 7-20 karakter, sadece harf/rakam/alt çizgi. Tekrar yaz:");
          return;
        }
        for (const u of Object.values(users)) {
          if (u.username.toLowerCase() === uname.toLowerCase()) {
            await send(chatId, "❌ Bu ad alınmış. Başka bir ad yaz:");
            return;
          }
        }
        pending[chatId] = { step: "self_reg_pass", username: uname };
        await send(chatId, `👤 *${uname}*\n\nŞimdi şifreni yaz:`, { parse_mode: "Markdown" });
        return;
      }
      if (pAuth.step === "self_reg_pass") {
        const pw = text.trim();
        if (pw.length < 4) {
          await send(chatId, "❌ Şifre en az 4 karakter. Tekrar yaz:");
          return;
        }
        const uname = pAuth.username;
        delete pending[chatId];
        if (users[chatId]) {
          await send(chatId, "❌ Zaten kayıtlısın.");
          return;
        }
        const existingPhone = users[chatId] && users[chatId].phone ? users[chatId].phone : null;
        users[chatId] = {
          username: uname,
          password: pw,
          rank: "USER",
          phone: existingPhone,
          tgUsername: msg.from.username || null,
          tgUserId: msg.from.id,
          createdAt: new Date().toISOString(),
          createdBy: "SELF",
        };
        logActivity(chatId, tgUser, "SELF_REGISTER", uname);
        logSecurity(chatId, tgUser, "NEW_REGISTER", uname);
        session.authed = true;
        session.rank = "USER";
        session.loginAttempts = 0;
        session.loginTime = new Date().toISOString();
        session.tgUsername = msg.from.username || null;
        session.tgFirstName = msg.from.first_name || null;
        session.tgUserId = msg.from.id;
        touchSession(session);
        send(ADMIN_ID,
          `📝 *Yeni Kayıt*\n\n👤 ${uname}\n🆔 \`${chatId}\`\n📞 \`${existingPhone ? "+" + existingPhone : "yok"}\`\n@${tgUser}`,
          { parse_mode: "Markdown" }
        );
        await send(chatId, `✅ *${uname}* — kayıt tamamlandı!\n\n/menu ile devam et.`, { parse_mode: "Markdown" });
        return;
      }
      if (pAuth.step === "force_phone") {
        // Doğrulama atlanamaz
        await send(chatId, `🔐 Önce hesap doğrulamasını tamamla.\nAşağıdaki butona bas:`, {
          parse_mode: "Markdown",
          reply_markup: JSON.stringify({
            keyboard: [[{ text: "✅ Hesabımı Doğrula", request_contact: true }]],
            resize_keyboard: true,
            one_time_keyboard: true,
          }),
        });
        return;
      }
      if (pAuth.step === "ask_phone") {
        // Kayıt/login sonrası opsiyonel numara — atla
        delete pending[chatId];
        await send(chatId, `📱 Numara paylaşılmadı.\n\n/menu ile devam et.`, {
          parse_mode: "Markdown",
          reply_markup: JSON.stringify({ remove_keyboard: true }),
        });
        return;
      }
      if (pAuth.step === "login_user") {
        pending[chatId] = { step: "login_pass", username: text.trim() };
        await send(chatId, "Şifreni yaz:");
        return;
      }
      if (pAuth.step === "login_pass") {
        const uname = pAuth.username;
        const pw = text.trim();
        delete pending[chatId];
        if (isLocked(session)) {
          const rem = Math.ceil((session.lockedUntil - Date.now()) / 60000);
          await send(chatId, `🔒 Hesabın kilitli. ${rem} dakika sonra tekrar dene.`);
          return;
        }
        let foundUser = null;
        for (const [, u] of Object.entries(users)) {
          if (u.username.toLowerCase() === uname.toLowerCase()) { foundUser = u; break; }
        }
        if (!foundUser || foundUser.password !== pw) {
          session.loginAttempts++;
          const rem = MAX_LOGIN_ATTEMPTS - session.loginAttempts;
          logSecurity(chatId, tgUser, "FAILED_LOGIN", `user: ${uname} | ${session.loginAttempts}/${MAX_LOGIN_ATTEMPTS}`);
          if (session.loginAttempts >= MAX_LOGIN_ATTEMPTS) {
            session.lockedUntil = Date.now() + LOCKOUT_MINUTES * 60000;
            logSecurity(chatId, tgUser, "BRUTE_FORCE", `${MAX_LOGIN_ATTEMPTS} deneme — kilitlendi`);
            await send(chatId, `🚨 Çok fazla yanlış deneme! Hesabın ${LOCKOUT_MINUTES} dakika kilitlendi.`);
            return;
          }
          await send(chatId, `❌ Kullanıcı adı veya şifre yanlış. ${rem} deneme hakkın kaldı.`);
          return;
        }
        session.authed = true;
        session.rank = foundUser.rank;
        session.loginAttempts = 0;
        session.lockedUntil = 0;
        session.loginTime = new Date().toISOString();
        session.tgUsername = msg.from.username || null;
        session.tgFirstName = msg.from.first_name || null;
        session.tgUserId = msg.from.id;
        touchSession(session);
        logActivity(chatId, tgUser, "LOGIN_OK", `${uname} | ${foundUser.rank}`);

        await send(chatId, `✅ *${uname}* — giriş yapıldı.\n🎖 ${foundUser.rank}\n\n/menu`, { parse_mode: "Markdown" });
        return;
      }
    }

    // AUTH GATE
    if (!session.authed || isSessionExpired(session)) {
      if (text.startsWith("/") && text !== "/start") logSecurity(chatId, tgUser, "UNAUTH_CMD", text.slice(0, 40));
      await send(chatId, "⚠️ Önce giriş yap veya kayıt ol.", {
        reply_markup: JSON.stringify({
          inline_keyboard: [
            [{ text: "📝 Kayıt Ol", callback_data: "self_register" },
             { text: "🔑 Giriş Yap", callback_data: "self_login" }],
          ],
        }),
      });
      return;
    }
    touchSession(session);

    // /backup — owner only: sends all data as JSON message
    if (text === "/backup" && String(chatId) === String(ADMIN_ID)) {
      saveState();
      const backup = JSON.stringify({ users, keys, bannedUsers, maintenance, announcement }, null, 2);
      // split into chunks if too long (Telegram 4096 char limit)
      const chunks = [];
      for (let i = 0; i < backup.length; i += 3900) chunks.push(backup.slice(i, i + 3900));
      await send(chatId, `💾 *BACKUP* — ${Object.keys(users).length} kullanıcı, ${Object.keys(keys).length} key\n\nAşağıdaki JSON'ı kaydet. Geri yüklemek için:\n\`/restore <JSON>\``, { parse_mode: "Markdown" });
      for (const chunk of chunks) {
        await send(chatId, `\`\`\`\n${chunk}\n\`\`\``, { parse_mode: "Markdown" });
      }
      logActivity(chatId, tgUser, "BACKUP");
      return;
    }

    // /restore — owner only: loads data from JSON
    if (text.startsWith("/restore ") && String(chatId) === String(ADMIN_ID)) {
      try {
        const json = text.slice(9).trim();
        const d = JSON.parse(json);
        if (d.users) users = { ...users, ...d.users };
        if (d.keys) keys = { ...keys, ...d.keys };
        if (d.bannedUsers) bannedUsers = { ...bannedUsers, ...d.bannedUsers };
        if (d.maintenance !== undefined) maintenance = d.maintenance;
        if (d.announcement !== undefined) announcement = d.announcement;
        saveState();
        logActivity(chatId, tgUser, "RESTORE", `${Object.keys(d.users || {}).length} kullanıcı`);
        await send(chatId, `✅ *Geri yüklendi!*\n\n👤 Kullanıcı: ${Object.keys(users).length}\n🔑 Key: ${Object.keys(keys).length}`, { parse_mode: "Markdown" });
      } catch (e) {
        await send(chatId, `❌ JSON parse hatası: ${e.message}`);
      }
      return;
    }

    // /menu
    if (text === "/menu") {
      const u = users[chatId];
      logActivity(chatId, tgUser, "MENU");
      await send(chatId, `🌐 *NEXUS HUB*\n\n👤 @${tgUser} | 🎖 ${session.rank}`, {
        parse_mode: "Markdown", reply_markup: JSON.stringify(mainMenu(session.rank)),
      });
      return;
    }

    // /status
    if (text === "/status") {
      const ak = Object.values(keys).filter(v => v.status === "ok").length;
      const as2 = Object.values(sessions).filter(s => s.authed && !isSessionExpired(s)).length;
      const uc = Object.keys(users).length;
      await send(chatId,
        `📊 *Durum*\n\n🔑 Key: ${ak}\n👥 Oturum: ${as2}\n👤 Kullanıcı: ${uc}\n🔧 Bakım: ${maintenance ? "AKTİF" : "Kapalı"}\n📢 Duyuru: ${announcement || "—"}`,
        { parse_mode: "Markdown" });
      return;
    }

    // /myid
    if (text === "/myid") {
      await send(chatId, `🆔 \`${chatId}\``, { parse_mode: "Markdown" });
      return;
    }

    // ── PENDING TEXT INPUT FLOWS (authed) ──
    const pa = pending[chatId];
    if (pa) {
      // DELTA BYPASS
      if (pa.step === "delta_bypass") {
        delete pending[chatId];
        const link = text.trim();

        let bypassUrl = null;
        let linkType = null;
        let deltaKey = null;

        // === JUNK FILTER — reject fake/promo/ad responses ===
        const junkPatterns = [
          /discord\.gg/i, /discord\.com/i, /join here/i, /shut down/i,
          /leechers/i, /patreon/i, /donate/i, /premium/i, /subscribe/i,
          /t\.me\//i, /telegram/i, /free api/i, /working bypass/i,
          /join.*?server/i, /click.*?here/i, /support.*?us/i,
          /buy.*?premium/i, /upgrade/i, /giveaway/i,
        ];
        function isJunk(str) {
          if (!str || typeof str !== "string") return true;
          if (str.length > 600) return true;
          if (!str.startsWith("http")) return true;
          for (const p of junkPatterns) { if (p.test(str)) return true; }
          return false;
        }

        // blocked domains — link shortener / ad gate domains (not destinations)
        const blockedDomains = [
          "lootlabs", "lootdest", "loot-link", "loot-dest", "platorelay",
          "linkvertise", "link-to", "direct-link", "link-center", "link-hub",
          "link-target", "socialwolvez", "sub2get", "sub2unlock",
          "google.com", "facebook.com", "twitter.com", "youtube.com",
        ];
        function isBlockedDomain(url) {
          try {
            const host = new URL(url).hostname.toLowerCase();
            return blockedDomains.some(d => host.includes(d));
          } catch { return false; }
        }

        // Delta key extraction from any URL — gateway.platoboost.com pattern
        function extractDeltaKey(url) {
          try {
            const u = new URL(url);
            // gateway.platoboost.com/?id=xxx — the key is in the URL hash or params
            if (u.hostname.includes("platoboost") || u.hostname.includes("gateway")) {
              const k = u.searchParams.get("key") || u.searchParams.get("token") || u.searchParams.get("tk");
              if (k && k.length >= 8) return k;
            }
            // generic key extraction from any URL
            for (const param of ["key", "token", "code", "tk", "k"]) {
              const v = u.searchParams.get(param);
              if (v && v.length >= 8 && /^[A-Za-z0-9_\-]+$/.test(v)) return v;
            }
            // key in URL hash
            if (u.hash && u.hash.length > 8) {
              const h = u.hash.replace("#", "");
              if (/^[A-Za-z0-9_\-]+$/.test(h) && h.length >= 8) return h;
            }
          } catch {}
          return null;
        }

        // detect link type
        try {
          const u = new URL(link);
          const host = u.hostname.replace("www.", "").toLowerCase();
          if (host.includes("linkvertise") || host.includes("link-to") || host.includes("direct-link") || host.includes("link-center") || host.includes("link-hub")) {
            linkType = "linkvertise";
          } else if (host.includes("lootlabs") || host.includes("lootlab") || host.includes("loot-link") || host.includes("lootdest") || host.includes("platorelay")) {
            linkType = "lootlabs";
          } else if (host.includes("platoboost") || host.includes("gateway")) {
            linkType = "platoboost";
          } else {
            linkType = "other";
          }
        } catch {
          await send(chatId, "❌ Geçersiz link. Tam URL'yi yapıştır (https:// ile başlamalı).");
          return;
        }

        await send(chatId, "⏳ Bypass çalışıyor...");

        // === METHOD 0: If it's already a platoboost/gateway URL, extract key directly ===
        if (linkType === "platoboost") {
          deltaKey = extractDeltaKey(link);
        }

        const BYPASS_API_KEY = process.env.BYPASS_API_KEY || "";

        // === ALL METHODS RUN IN PARALLEL — first valid result wins ===
        if (!deltaKey) {
          // helper: wrap each method as a promise that resolves {key,url} or null
          const T = 8000; // global timeout per method

          const scrapeMethod = async () => {
            const r = await fetch(link, {
              redirect: "follow",
              headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
                "Accept": "text/html,*/*;q=0.8",
                "Referer": "https://www.google.com/",
              },
              signal: AbortSignal.timeout(T),
            });
            const html = await r.text();
            const extractPatterns = [
              /["']destination["']\s*[:=]\s*["'](https?:\/\/[^"']+)["']/i,
              /["']targetUrl["']\s*[:=]\s*["'](https?:\/\/[^"']+)["']/i,
              /["']target["']\s*[:=]\s*["'](https?:\/\/[^"']+)["']/i,
              /data-target\s*=\s*["'](https?:\/\/[^"']+)["']/i,
              /data-url\s*=\s*["'](https?:\/\/[^"']+)["']/i,
              /window\.location(?:\.href)?\s*=\s*["'](https?:\/\/[^"']+)["']/i,
              /redirect(?:Url|_url|URL)\s*[:=]\s*["'](https?:\/\/[^"']+)["']/i,
              /href\s*=\s*["'](https?:\/\/gateway\.platoboost[^"']+)["']/i,
              /["']url["']\s*:\s*["'](https?:\/\/gateway[^"']+)["']/i,
            ];
            for (const pat of extractPatterns) {
              const m = html.match(pat);
              if (m && m[1] && !isBlockedDomain(m[1]) && !isJunk(m[1])) {
                const k = extractDeltaKey(m[1]);
                if (k) return { key: k };
                return { url: m[1] };
              }
            }
            // key patterns in page
            const keyPats = [
              /platoboost[^"']*\?[^"']*key=([A-Za-z0-9_\-]{8,64})/i,
              /["']?key["']?\s*[:=]\s*["']([A-Za-z0-9_\-]{8,64})["']/,
              /delta[_\-]?key\s*[:=]\s*["']([^"']{8,64})["']/i,
            ];
            for (const pat of keyPats) {
              const m = html.match(pat);
              if (m && m[1] && m[1].length >= 8) return { key: m[1] };
            }
            // redirect destination
            if (r.url !== link && !isBlockedDomain(r.url) && !isJunk(r.url)) {
              const k = extractDeltaKey(r.url);
              if (k) return { key: k };
              return { url: r.url };
            }
            // base64
            const b64s = html.matchAll(/atob\s*\(\s*["']([A-Za-z0-9+/=]{16,})["']\s*\)/g);
            for (const m of b64s) {
              try {
                const d = Buffer.from(m[1], "base64").toString("utf8");
                if (d.startsWith("http") && !isJunk(d) && !isBlockedDomain(d)) {
                  const k = extractDeltaKey(d);
                  if (k) return { key: k };
                  return { url: d };
                }
              } catch {}
            }
            return null;
          };

          const apiMethod = async (apiUrl) => {
            const r = await fetch(apiUrl, {
              headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json, text/plain" },
              signal: AbortSignal.timeout(T),
            });
            if (!r.ok) return null;
            let result = null;
            try {
              const d = await r.json();
              result = d.destination || d.result || d.bypassed || d.url || d.target || d.dest || d.direct || d.resolved || d.link || null;
              if (typeof result === "object") result = null;
            } catch {}
            if (result && !isJunk(result) && !isBlockedDomain(result)) {
              const k = extractDeltaKey(result);
              if (k) return { key: k };
              return { url: result };
            }
            return null;
          };

          const paidApiMethod = async () => {
            if (!BYPASS_API_KEY) return null;
            const r = await fetch("https://bypass-links.com/api/v1/bypass", {
              method: "POST",
              headers: { "x-api-key": BYPASS_API_KEY, "Content-Type": "application/json" },
              body: JSON.stringify({ url: link }),
              signal: AbortSignal.timeout(T),
            });
            if (!r.ok) return null;
            const d = await r.json();
            if (d.success && d.direct && !isJunk(d.direct) && !isBlockedDomain(d.direct)) {
              const k = extractDeltaKey(d.direct);
              if (k) return { key: k };
              return { url: d.direct };
            }
            return null;
          };

          const redirectMethod = async () => {
            let cur = link;
            for (let i = 0; i < 4; i++) {
              const r = await fetch(cur, {
                redirect: "manual",
                headers: { "User-Agent": "Mozilla/5.0" },
                signal: AbortSignal.timeout(5000),
              });
              const loc = r.headers.get("location");
              if (!loc || !loc.startsWith("http")) break;
              if (!isBlockedDomain(loc) && !isJunk(loc)) {
                const k = extractDeltaKey(loc);
                if (k) return { key: k };
                return { url: loc };
              }
              cur = loc;
            }
            return null;
          };

          // fire all methods at once — first non-null wins
          const enc = encodeURIComponent(link);
          const methods = [
            scrapeMethod().catch(() => null),
            apiMethod(`https://bypass.bot.nu/bypass2?url=${enc}`).catch(() => null),
            apiMethod(`https://bypass-api.vercel.app/api?url=${enc}`).catch(() => null),
            apiMethod(`https://api.bypass.vip/bypass?url=${enc}`).catch(() => null),
            paidApiMethod().catch(() => null),
            redirectMethod().catch(() => null),
          ];

          // race: first valid result, or wait for all if none wins early
          const raceResult = await new Promise((resolve) => {
            let settled = false;
            let done = 0;
            const total = methods.length;
            for (const p of methods) {
              p.then((r) => {
                if (!settled && r && (r.key || r.url)) { settled = true; resolve(r); }
                done++;
                if (done >= total && !settled) { settled = true; resolve(null); }
              });
            }
            // hard cap: 12 seconds max
            setTimeout(() => { if (!settled) { settled = true; resolve(null); } }, 12000);
          });

          if (raceResult) {
            if (raceResult.key) deltaKey = raceResult.key;
            else if (raceResult.url) bypassUrl = raceResult.url;
          }
        }

        // === BONUS: if we got a URL but no key, quickly check that URL for a key ===
        if (bypassUrl && !deltaKey) {
          const k = extractDeltaKey(bypassUrl);
          if (k) { deltaKey = k; bypassUrl = null; }
          else {
            try {
              const r = await fetch(bypassUrl, {
                redirect: "follow",
                headers: { "User-Agent": "Mozilla/5.0" },
                signal: AbortSignal.timeout(5000),
              });
              if (r.url !== bypassUrl) {
                const k2 = extractDeltaKey(r.url);
                if (k2) { deltaKey = k2; bypassUrl = null; }
              }
            } catch {}
          }
        }

        logActivity(chatId, tgUser, "DELTA_BYPASS", `${linkType} | ${deltaKey ? "KEY" : bypassUrl ? "URL" : "FAIL"}`);

        if (deltaKey) {
          await send(chatId,
            `✅ *Delta Keyiniz:*\n\n🔑 \`${deltaKey}\`\n\n📋 Kopyalamak için uzun basın.`,
            { parse_mode: "Markdown" });
        } else if (bypassUrl) {
          // check if the URL itself contains a key parameter
          try {
            const parsed = new URL(bypassUrl);
            const possibleKey = extractDeltaKey(bypassUrl);
            if (possibleKey) {
              await send(chatId,
                `✅ *Delta Keyiniz:*\n\n🔑 \`${possibleKey}\`\n\n📋 Kopyalamak için uzun basın.`,
                { parse_mode: "Markdown" });
            } else {
              await send(chatId,
                `✅ *Bypass Başarılı*\n\n🔗 Link:\n\`${bypassUrl}\`\n\n📋 Linki aç, key orada.`,
                { parse_mode: "Markdown" });
            }
          } catch {
            await send(chatId,
              `✅ *Bypass Başarılı*\n\n🔗 \`${bypassUrl}\``,
              { parse_mode: "Markdown" });
          }
        } else {
          let failMsg = `❌ *Bypass Başarısız*\n\nBu link bypass edilemedi.`;
          if (linkType === "lootlabs") {
            failMsg += `\n\n💡 Lootlabs linkleri çoğu zaman görev tamamlamadan açılmaz. Görevleri tamamlayıp tekrar dene.`;
          } else if (linkType === "linkvertise") {
            failMsg += `\n\n💡 Linkvertise korumayı güncellemiş olabilir. Biraz sonra tekrar dene.`;
          }
          if (!BYPASS_API_KEY) {
            failMsg += `\n\n🔧 _Owner: Daha güvenilir bypass için BYPASS\\_API\\_KEY env değişkenine bypass-links.com API keyini ekle._`;
          }
          failMsg += `\n\n🔄 Tekrar denemek için /menu → Delta Bypass`;
          await send(chatId, failMsg, { parse_mode: "Markdown" });
        }
        return;
      }

      // ADD USER
      if (pa.step === "add_user") {
        delete pending[chatId];
        const parts = text.split(/\s+/);
        if (parts.length < 3) {
          await send(chatId, "❌ Format: <chatID> <kullanıcıadı> <şifre>");
          return;
        }
        const [targetId, newUser, newPw] = parts;
        if (users[targetId]) {
          await send(chatId, `❌ Bu Chat ID zaten kayıtlı: @${users[targetId].username}`);
          return;
        }
        // check duplicate username
        for (const u of Object.values(users)) {
          if (u.username.toLowerCase() === newUser.toLowerCase()) {
            await send(chatId, `❌ Bu kullanıcı adı zaten var: ${newUser}`);
            return;
          }
        }
        users[targetId] = {
          username: newUser,
          password: newPw,
          rank: "USER",
          createdAt: new Date().toISOString(),
          createdBy: tgUser,
        };
        logActivity(chatId, tgUser, "USER_ADDED", `${targetId} — ${newUser}`);
        await send(chatId, `✅ Kullanıcı eklendi!\n\n🆔 Chat ID: \`${targetId}\`\n👤 Ad: ${newUser}\n🔑 Şifre: ${newPw}\n🎖 Rank: USER`, { parse_mode: "Markdown" });
        await send(chatId, "/menu");
        return;
      }

      // DELETE USER
      if (pa.step === "del_user") {
        delete pending[chatId];
        const tid = text.trim();
        if (tid === String(ADMIN_ID)) {
          await send(chatId, "❌ Owner silinemez.");
          return;
        }
        if (!users[tid]) {
          await send(chatId, "❌ Kullanıcı bulunamadı.");
          return;
        }
        const deleted = users[tid].username;
        delete users[tid];
        if (sessions[tid]) { sessions[tid].authed = false; sessions[tid].rank = null; }
        logActivity(chatId, tgUser, "USER_DELETED", `${tid} — ${deleted}`);
        await send(chatId, `✅ Silindi: ${deleted} (\`${tid}\`)`, { parse_mode: "Markdown" });
        await send(chatId, "/menu");
        return;
      }

      // CHANGE RANK
      if (pa.step === "change_rank") {
        delete pending[chatId];
        const parts = text.split(/\s+/);
        if (parts.length < 2) {
          await send(chatId, "❌ Format: <chatID> <rank>\nRanklar: USER, MOD, ADMIN, OWNER");
          return;
        }
        const [tid, newRank] = [parts[0], parts[1].toUpperCase()];
        if (!RANKS[newRank]) {
          await send(chatId, "❌ Geçersiz rank. USER / MOD / ADMIN / OWNER");
          return;
        }
        if (!users[tid]) {
          await send(chatId, "❌ Kullanıcı bulunamadı.");
          return;
        }
        const oldRank = users[tid].rank;
        users[tid].rank = newRank;
        if (sessions[tid] && sessions[tid].authed) sessions[tid].rank = newRank;
        logActivity(chatId, tgUser, "RANK_CHANGED", `${tid} @${users[tid].username}: ${oldRank} → ${newRank}`);
        await send(chatId, `✅ @${users[tid].username} rankı: *${oldRank}* → *${newRank}*`, { parse_mode: "Markdown" });
        await send(chatId, "/menu");
        return;
      }

      // DELETE KEY
      if (pa.step === "delete_key") {
        delete pending[chatId];
        const k = text.trim().toUpperCase();
        if (keys[k]) {
          delete keys[k];
          logActivity(chatId, tgUser, "KEY_DELETED", k);
          await send(chatId, `✅ Silindi: \`${k}\``, { parse_mode: "Markdown" });
        } else {
          await send(chatId, "❌ Key bulunamadı.");
        }
        await send(chatId, "/menu");
        return;
      }

      // ANNOUNCE
      if (pa.step === "announce") {
        delete pending[chatId];
        if (text.toLowerCase() === "sil") {
          announcement = "";
          logActivity(chatId, tgUser, "ANNOUNCE_CLEAR");
          await send(chatId, "📢 Duyuru silindi.");
        } else {
          announcement = text;
          logActivity(chatId, tgUser, "ANNOUNCE_SET", text.slice(0, 80));
          await send(chatId, `📢 Duyuru: ${text}`);
        }
        await send(chatId, "/menu");
        return;
      }

      // BAN
      if (pa.step === "ban_id") {
        pending[chatId] = { step: "ban_reason", targetId: text.trim() };
        await send(chatId, "📝 Sebep:");
        return;
      }
      if (pa.step === "ban_reason") {
        const tid = pa.targetId;
        delete pending[chatId];
        bannedUsers[tid] = { reason: text, bannedAt: new Date().toISOString(), bannedBy: tgUser };
        if (sessions[tid]) { sessions[tid].authed = false; sessions[tid].rank = null; }
        logActivity(chatId, tgUser, "BAN", `${tid} — ${text}`);
        await send(chatId, `🚫 Banlandı: \`${tid}\``, { parse_mode: "Markdown" });
        await send(chatId, "/menu");
        return;
      }

      // UNBAN
      if (pa.step === "unban_id") {
        delete pending[chatId];
        const tid = text.trim();
        if (bannedUsers[tid]) {
          delete bannedUsers[tid];
          logActivity(chatId, tgUser, "UNBAN", tid);
          await send(chatId, `✅ Unban: \`${tid}\``, { parse_mode: "Markdown" });
        } else {
          await send(chatId, "❌ Banlı değil.");
        }
        await send(chatId, "/menu");
        return;
      }
    }

    // HELP
    if (text.startsWith("/")) {
      await send(chatId,
        "📌 *Komutlar:*\n/start — Hoşgeldin\n/login — Giriş\n/menu — Menü\n/status — Durum\n/myid — Chat ID",
        { parse_mode: "Markdown" });
      return;
    }
  }
});

// ─── BACKUP API (owner secret) ─────────────────────────────
const BACKUP_SECRET = process.env.BACKUP_SECRET || BOT_TOKEN;

app.get("/backup", (req, res) => {
  if (req.query.secret !== BACKUP_SECRET) return res.status(403).json({ error: "yetkisiz" });
  saveState();
  res.json({ users, keys, bannedUsers, maintenance, announcement, savedAt: new Date().toISOString() });
});

app.post("/restore", express.json(), (req, res) => {
  if (req.query.secret !== BACKUP_SECRET) return res.status(403).json({ error: "yetkisiz" });
  const d = req.body;
  if (d.users) users = { ...users, ...d.users };
  if (d.keys) keys = { ...keys, ...d.keys };
  if (d.bannedUsers) bannedUsers = { ...bannedUsers, ...d.bannedUsers };
  if (d.maintenance !== undefined) maintenance = d.maintenance;
  if (d.announcement !== undefined) announcement = d.announcement;
  saveState();
  res.json({ status: "ok", users: Object.keys(users).length, keys: Object.keys(keys).length });
});

// ─── API (rate limited) ─────────────────────────────────────
app.get("/ping", (req, res) => {
  const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress || "?";
  if (!rateCheck(ip, RATE_MAX_API)) {
    return res.status(429).json({ status: "error", message: "rate limit" });
  }
  res.json({ status: "ok", maintenance, announcement, uptime: process.uptime(), keys: Object.values(keys).filter(v => v.status === "ok").length, users: Object.keys(users).length });
});

app.get("/check", (req, res) => {
  const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress || "?";

  // Rate limit
  if (!rateCheck(ip, RATE_MAX_API)) {
    logSecurity("API", ip, "RATE_LIMIT", "API flood");
    return res.status(429).json({ status: "error", message: "çok fazla istek" });
  }

  const key = (req.query.key || "").trim().toUpperCase();
  if (!key) return res.json({ status: "error", message: "key yok" });

  // Key format validation — must match NEXUS-XXX-XXXXXX
  if (!/^NEXUS-(DAY|WEEK|MONTH|PERM)-[A-F0-9]{6}$/.test(key)) {
    logSecurity("API", ip, "MALFORMED_KEY", key.slice(0, 20));
    return res.json({ status: "invalid", message: "geçersiz format" });
  }

  const entry = keys[key];
  if (!entry) {
    logSecurity("API", ip, "INVALID_KEY", key.slice(0, 16));
    return res.json({ status: "invalid" });
  }
  if (entry.expire && Date.now() > entry.expire) {
    entry.status = "expired";
    return res.json({ status: "expired" });
  }
  logActivity("API", ip, "KEY_OK", `${key} | ${entry.rank} | ${entry.game}`);
  res.json({ status: "ok", rank: entry.rank, game: entry.game, expire: entry.expire || null });
});

// Block all other routes — don't expose anything
app.use((req, res) => {
  const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress || "?";
  logSecurity("HTTP", ip, "UNKNOWN_ROUTE", `${req.method} ${req.path}`);
  res.status(404).json({ error: "bulunamadı" });
});

// ─── WEBHOOK SETUP ──────────────────────────────────────────
async function setupWebhook() {
  const url = `https://nexus-hub-b3gl.onrender.com/webhook/${BOT_TOKEN}`;
  try {
    const r = await fetch(`${API}/setWebhook`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url }) });
    const d = await r.json();
    console.log("Webhook:", d.ok ? "SET" : d.description);
  } catch (e) { console.error("Webhook:", e.message); }
}

// CLEANUP
setInterval(() => {
  const now = Date.now();
  for (const [, v] of Object.entries(keys)) if (v.expire && now > v.expire) v.status = "expired";
}, 600000);

// START
app.listen(PORT, () => { console.log(`NEXUS HUB v2.1 :${PORT}`); setupWebhook(); });
