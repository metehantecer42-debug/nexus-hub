// ═══════════════════════════════════════════════════════════════
//  NEXUS HUB — Telegram Bot + Key API Server
//  Built by Olivia — https://discord.gg/ojailbreaks
//  Owner: Olivia (ADMIN_ID env)
//  Fixed owner password — no registration
// ═══════════════════════════════════════════════════════════════

const express = require("express");
const crypto = require("crypto");
const app = express();
app.use(express.json());

// ─── ENV ────────────────────────────────────────────────────
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = process.env.ADMIN_ID || "8961529079";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "nexus2024";
const PORT = process.env.PORT || 3000;
const API = `https://api.telegram.org/bot${BOT_TOKEN}`;

// ─── IN-MEMORY STATE ────────────────────────────────────────
let keys = {};           // key -> { status, rank, game, expire, createdBy, createdAt }
let sessions = {};       // chatId -> { authed, rank, lastActivity, loginAttempts, lockedUntil }
let activityLog = [];    // { time, chatId, username, action, detail }
let maintenance = false;
let announcement = "";
let bannedUsers = {};    // chatId -> { reason, bannedAt, bannedBy }
let securityAlerts = []; // { time, chatId, username, type, detail }

// ─── RANK PERMISSIONS ───────────────────────────────────────
const RANKS = {
  OWNER: 4,
  ADMIN: 3,
  MOD: 2,
  USER: 1,
};

function rankLevel(r) { return RANKS[r] || 0; }

// ─── SECURITY ───────────────────────────────────────────────
const MAX_LOGIN_ATTEMPTS = 5;
const LOCKOUT_MINUTES = 15;
const SESSION_TIMEOUT_MINUTES = 120;

function getSession(chatId) {
  if (!sessions[chatId]) {
    sessions[chatId] = {
      authed: false,
      rank: null,
      lastActivity: 0,
      loginAttempts: 0,
      lockedUntil: 0,
    };
  }
  return sessions[chatId];
}

function isLocked(session) {
  if (session.lockedUntil && Date.now() < session.lockedUntil) return true;
  if (session.lockedUntil && Date.now() >= session.lockedUntil) {
    session.loginAttempts = 0;
    session.lockedUntil = 0;
  }
  return false;
}

function isSessionExpired(session) {
  if (!session.authed) return true;
  if (Date.now() - session.lastActivity > SESSION_TIMEOUT_MINUTES * 60 * 1000) {
    session.authed = false;
    session.rank = null;
    return true;
  }
  return false;
}

function touchSession(session) {
  session.lastActivity = Date.now();
}

function logActivity(chatId, username, action, detail = "") {
  const entry = {
    time: new Date().toISOString(),
    chatId: String(chatId),
    username: username || "unknown",
    action,
    detail,
  };
  activityLog.push(entry);
  if (activityLog.length > 500) activityLog.shift();
}

function logSecurity(chatId, username, type, detail = "") {
  const entry = {
    time: new Date().toISOString(),
    chatId: String(chatId),
    username: username || "unknown",
    type,
    detail,
  };
  securityAlerts.push(entry);
  if (securityAlerts.length > 200) securityAlerts.shift();
  // notify owner on critical events
  if (type === "BRUTE_FORCE" || type === "BANNED_ACCESS") {
    send(ADMIN_ID, `🚨 *GÜVENLİK ALARMI*\n\nTip: \`${type}\`\nKullanıcı: @${username || "?"} (${chatId})\nDetay: ${detail}\nZaman: ${entry.time}`, { parse_mode: "Markdown" });
  }
}

// ─── GENERATE KEY ───────────────────────────────────────────
function generateKey(duration, rank, game) {
  const hex = crypto.randomBytes(3).toString("hex").toUpperCase();
  const tag = duration.toUpperCase();
  const key = `NEXUS-${tag}-${hex}`;
  const now = Date.now();
  let expire = 0;
  if (tag === "DAY") expire = now + 86400000;
  else if (tag === "WEEK") expire = now + 604800000;
  else if (tag === "MONTH") expire = now + 2592000000;
  // PERM = 0 means no expiry
  keys[key] = {
    status: "ok",
    rank: rank || "USER",
    game: game || "all",
    expire,
    createdAt: new Date().toISOString(),
  };
  return key;
}

// ─── TELEGRAM HELPERS ───────────────────────────────────────
async function send(chatId, text, extra = {}) {
  try {
    await fetch(`${API}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, ...extra }),
    });
  } catch (e) { console.error("send error:", e.message); }
}

async function editMessage(chatId, msgId, text, extra = {}) {
  try {
    await fetch(`${API}/editMessageText`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, message_id: msgId, text, ...extra }),
    });
  } catch (e) { console.error("edit error:", e.message); }
}

async function answerCallback(callbackId, text = "") {
  try {
    await fetch(`${API}/answerCallbackQuery`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ callback_query_id: callbackId, text }),
    });
  } catch (e) {}
}

// ─── INLINE KEYBOARDS ──────────────────────────────────────
function mainMenu(rank) {
  const rows = [
    [{ text: "🔑 Key Oluştur", callback_data: "key_create" }],
    [{ text: "📋 Aktif Keyler", callback_data: "key_list" }],
    [{ text: "❌ Key Sil", callback_data: "key_delete_prompt" }],
  ];
  if (rankLevel(rank) >= RANKS.ADMIN) {
    rows.push([{ text: "📊 Aktivite Logu", callback_data: "view_activity" }]);
    rows.push([{ text: "🚨 Güvenlik Logları", callback_data: "view_security" }]);
    rows.push([{ text: "👥 Aktif Oturumlar", callback_data: "view_sessions" }]);
  }
  if (rankLevel(rank) >= RANKS.OWNER) {
    rows.push([
      { text: "🔧 Bakım Modu", callback_data: "toggle_maintenance" },
      { text: "📢 Duyuru", callback_data: "set_announce" },
    ]);
    rows.push([
      { text: "🚫 Ban", callback_data: "ban_prompt" },
      { text: "✅ Unban", callback_data: "unban_prompt" },
    ]);
  }
  rows.push([{ text: "🔒 Çıkış Yap", callback_data: "logout" }]);
  return { inline_keyboard: rows };
}

function durationKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "⏱ Günlük", callback_data: "dur_DAY" },
        { text: "📅 Haftalık", callback_data: "dur_WEEK" },
      ],
      [
        { text: "🗓 Aylık", callback_data: "dur_MONTH" },
        { text: "♾ Süresiz", callback_data: "dur_PERM" },
      ],
    ],
  };
}

function rankKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "👤 USER", callback_data: "rank_USER" },
        { text: "🛡 MOD", callback_data: "rank_MOD" },
      ],
      [
        { text: "⚡ ADMIN", callback_data: "rank_ADMIN" },
        { text: "👑 OWNER", callback_data: "rank_OWNER" },
      ],
    ],
  };
}

function gameKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "🌍 Tüm Oyunlar", callback_data: "game_all" }],
      [{ text: "🌾 Kukirin", callback_data: "game_kukirin" }],
      [{ text: "🔧 Build & Weld", callback_data: "game_buildweld" }],
      [{ text: "🏙️ San Diego RP", callback_data: "game_sdrp" }],
    ],
  };
}

// ─── PENDING STATE PER CHAT ─────────────────────────────────
let pendingAction = {}; // chatId -> { step, duration, rank, game, ... }

// ─── WEBHOOK HANDLER ────────────────────────────────────────
app.post(`/webhook/${BOT_TOKEN}`, async (req, res) => {
  res.sendStatus(200);
  const body = req.body;

  // ── CALLBACK QUERIES ──
  if (body.callback_query) {
    const cb = body.callback_query;
    const chatId = cb.message.chat.id;
    const msgId = cb.message.message_id;
    const data = cb.data;
    const username = cb.from.username || cb.from.first_name || "?";
    const session = getSession(chatId);

    await answerCallback(cb.id);

    // must be authed for everything except nothing
    if (!session.authed || isSessionExpired(session)) {
      if (data !== "logout") {
        await send(chatId, "⚠️ Oturum süresi dolmuş. Tekrar giriş yapın: /login <şifre>");
        return;
      }
    }
    touchSession(session);

    // ── LOGOUT ──
    if (data === "logout") {
      session.authed = false;
      session.rank = null;
      logActivity(chatId, username, "LOGOUT");
      await send(chatId, "🔒 Çıkış yapıldı.");
      return;
    }

    // ── KEY CREATE FLOW ──
    if (data === "key_create") {
      pendingAction[chatId] = { step: "duration" };
      logActivity(chatId, username, "KEY_CREATE_START");
      await editMessage(chatId, msgId, "⏱ *Key Süresi Seçin:*", {
        parse_mode: "Markdown",
        reply_markup: JSON.stringify(durationKeyboard()),
      });
      return;
    }

    if (data.startsWith("dur_")) {
      const dur = data.replace("dur_", "");
      if (!pendingAction[chatId]) return;
      pendingAction[chatId].duration = dur;
      pendingAction[chatId].step = "rank";
      await editMessage(chatId, msgId, "🎖 *Rank Seçin:*", {
        parse_mode: "Markdown",
        reply_markup: JSON.stringify(rankKeyboard()),
      });
      return;
    }

    if (data.startsWith("rank_")) {
      const rnk = data.replace("rank_", "");
      if (!pendingAction[chatId]) return;
      pendingAction[chatId].rank = rnk;
      pendingAction[chatId].step = "game";
      await editMessage(chatId, msgId, "🎮 *Oyun Seçin:*", {
        parse_mode: "Markdown",
        reply_markup: JSON.stringify(gameKeyboard()),
      });
      return;
    }

    if (data.startsWith("game_")) {
      const gm = data.replace("game_", "");
      if (!pendingAction[chatId]) return;
      const p = pendingAction[chatId];
      const key = generateKey(p.duration, p.rank, gm);
      delete pendingAction[chatId];
      logActivity(chatId, username, "KEY_CREATED", `${key} | ${p.rank} | ${gm} | ${p.duration}`);
      await editMessage(chatId, msgId,
        `✅ *Key Oluşturuldu!*\n\n` +
        `🔑 Key: \`${key}\`\n` +
        `⏱ Süre: *${p.duration}*\n` +
        `🎖 Rank: *${p.rank}*\n` +
        `🎮 Oyun: *${gm}*\n\n` +
        `📋 Kopyalamak için key'e dokunun.`,
        { parse_mode: "Markdown", reply_markup: JSON.stringify(mainMenu(session.rank)) }
      );
      return;
    }

    // ── KEY LIST ──
    if (data === "key_list") {
      const entries = Object.entries(keys).filter(([, v]) => v.status === "ok");
      if (entries.length === 0) {
        await editMessage(chatId, msgId, "📋 Aktif key bulunamadı.", {
          reply_markup: JSON.stringify(mainMenu(session.rank)),
        });
        return;
      }
      let txt = "📋 *Aktif Keyler:*\n\n";
      for (const [k, v] of entries) {
        const exp = v.expire ? new Date(v.expire).toLocaleDateString("tr-TR") : "♾ Süresiz";
        txt += `🔑 \`${k}\`\n   Rank: ${v.rank} | Oyun: ${v.game} | Bitiş: ${exp}\n\n`;
      }
      logActivity(chatId, username, "KEY_LIST_VIEW");
      await editMessage(chatId, msgId, txt, {
        parse_mode: "Markdown",
        reply_markup: JSON.stringify(mainMenu(session.rank)),
      });
      return;
    }

    // ── KEY DELETE PROMPT ──
    if (data === "key_delete_prompt") {
      pendingAction[chatId] = { step: "delete_key" };
      await editMessage(chatId, msgId, "❌ Silmek istediğiniz key'i yazın:");
      return;
    }

    // ── TOGGLE MAINTENANCE ──
    if (data === "toggle_maintenance") {
      maintenance = !maintenance;
      logActivity(chatId, username, "MAINTENANCE_TOGGLE", maintenance ? "ON" : "OFF");
      await editMessage(chatId, msgId, `🔧 Bakım Modu: ${maintenance ? "✅ AKTİF" : "❌ KAPALI"}`, {
        reply_markup: JSON.stringify(mainMenu(session.rank)),
      });
      return;
    }

    // ── SET ANNOUNCE PROMPT ──
    if (data === "set_announce") {
      pendingAction[chatId] = { step: "announce" };
      await editMessage(chatId, msgId, "📢 Duyuru metnini yazın (sıfırlamak için 'sil' yazın):");
      return;
    }

    // ── BAN PROMPT ──
    if (data === "ban_prompt") {
      pendingAction[chatId] = { step: "ban_id" };
      await editMessage(chatId, msgId, "🚫 Banlamak istediğiniz kullanıcının Chat ID'sini yazın:");
      return;
    }

    // ── UNBAN PROMPT ──
    if (data === "unban_prompt") {
      pendingAction[chatId] = { step: "unban_id" };
      await editMessage(chatId, msgId, "✅ Unban yapmak istediğiniz Chat ID'yi yazın:");
      return;
    }

    // ── VIEW ACTIVITY ──
    if (data === "view_activity") {
      const last20 = activityLog.slice(-20).reverse();
      if (last20.length === 0) {
        await editMessage(chatId, msgId, "📊 Henüz aktivite yok.", {
          reply_markup: JSON.stringify(mainMenu(session.rank)),
        });
        return;
      }
      let txt = "📊 *Son Aktiviteler:*\n\n";
      for (const e of last20) {
        const t = e.time.slice(11, 19);
        txt += `\`${t}\` @${e.username} — *${e.action}*${e.detail ? `\n   ${e.detail}` : ""}\n`;
      }
      await editMessage(chatId, msgId, txt, {
        parse_mode: "Markdown",
        reply_markup: JSON.stringify(mainMenu(session.rank)),
      });
      return;
    }

    // ── VIEW SECURITY LOGS ──
    if (data === "view_security") {
      const last20 = securityAlerts.slice(-20).reverse();
      if (last20.length === 0) {
        await editMessage(chatId, msgId, "🚨 Güvenlik kaydı yok.", {
          reply_markup: JSON.stringify(mainMenu(session.rank)),
        });
        return;
      }
      let txt = "🚨 *Güvenlik Logları:*\n\n";
      for (const e of last20) {
        const t = e.time.slice(11, 19);
        txt += `\`${t}\` [${e.type}] @${e.username} (${e.chatId})\n   ${e.detail}\n\n`;
      }
      await editMessage(chatId, msgId, txt, {
        parse_mode: "Markdown",
        reply_markup: JSON.stringify(mainMenu(session.rank)),
      });
      return;
    }

    // ── VIEW SESSIONS ──
    if (data === "view_sessions") {
      const active = Object.entries(sessions).filter(([, s]) => s.authed && !isSessionExpired(s));
      if (active.length === 0) {
        await editMessage(chatId, msgId, "👥 Aktif oturum yok.", {
          reply_markup: JSON.stringify(mainMenu(session.rank)),
        });
        return;
      }
      let txt = "👥 *Aktif Oturumlar:*\n\n";
      for (const [id, s] of active) {
        const ago = Math.floor((Date.now() - s.lastActivity) / 60000);
        txt += `🔹 \`${id}\` — Rank: *${s.rank}* — ${ago}dk önce aktif\n`;
      }
      await editMessage(chatId, msgId, txt, {
        parse_mode: "Markdown",
        reply_markup: JSON.stringify(mainMenu(session.rank)),
      });
      return;
    }

    return;
  }

  // ── TEXT MESSAGES ──
  if (body.message && body.message.text) {
    const msg = body.message;
    const chatId = msg.chat.id;
    const text = msg.text.trim();
    const username = msg.from.username || msg.from.first_name || "?";
    const session = getSession(chatId);

    // ── BANNED CHECK ──
    if (bannedUsers[chatId]) {
      logSecurity(chatId, username, "BANNED_ACCESS", `Tried: ${text.slice(0, 30)}`);
      await send(chatId, `🚫 Hesabınız banlanmış.\nSebep: ${bannedUsers[chatId].reason || "Belirtilmedi"}`);
      return;
    }

    // ── /start ──
    if (text === "/start") {
      logActivity(chatId, username, "BOT_START");
      await send(chatId,
        `╔══════════════════════════╗\n` +
        `║     🌐 NEXUS HUB 🌐     ║\n` +
        `╠══════════════════════════╣\n` +
        `║  Key Yönetim Sistemi     ║\n` +
        `║  v2.0 — Güvenli Giriş   ║\n` +
        `╚══════════════════════════╝\n\n` +
        `🔐 Giriş yapmak için:\n/login <şifre>\n\n` +
        `⚠️ ${MAX_LOGIN_ATTEMPTS} başarısız deneme = ${LOCKOUT_MINUTES}dk kilit`
      );
      return;
    }

    // ── /login <password> ──
    if (text.startsWith("/login")) {
      const parts = text.split(" ");
      const pw = parts[1] || "";

      // lockout check
      if (isLocked(session)) {
        const remaining = Math.ceil((session.lockedUntil - Date.now()) / 60000);
        logSecurity(chatId, username, "LOCKED_LOGIN_ATTEMPT", `${remaining}dk kalan`);
        await send(chatId, `🔒 Hesap kilitli. ${remaining} dakika bekleyin.`);
        return;
      }

      if (!pw) {
        await send(chatId, "⚠️ Kullanım: /login <şifre>");
        return;
      }

      if (pw !== ADMIN_PASSWORD) {
        session.loginAttempts++;
        const remaining = MAX_LOGIN_ATTEMPTS - session.loginAttempts;
        logSecurity(chatId, username, "FAILED_LOGIN", `Deneme ${session.loginAttempts}/${MAX_LOGIN_ATTEMPTS} — şifre: ${pw.slice(0, 2)}***`);

        if (session.loginAttempts >= MAX_LOGIN_ATTEMPTS) {
          session.lockedUntil = Date.now() + LOCKOUT_MINUTES * 60 * 1000;
          logSecurity(chatId, username, "BRUTE_FORCE", `${MAX_LOGIN_ATTEMPTS} başarısız deneme — ${LOCKOUT_MINUTES}dk kilitlendi`);
          await send(chatId, `🚨 Çok fazla başarısız deneme!\nHesap ${LOCKOUT_MINUTES} dakika kilitlendi.`);
          return;
        }

        await send(chatId, `❌ Yanlış şifre. Kalan hak: ${remaining}`);
        return;
      }

      // success
      session.authed = true;
      session.rank = String(chatId) === String(ADMIN_ID) ? "OWNER" : "USER";
      session.loginAttempts = 0;
      session.lockedUntil = 0;
      touchSession(session);
      logActivity(chatId, username, "LOGIN_SUCCESS", `Rank: ${session.rank}`);
      logSecurity(chatId, username, "LOGIN_OK", `IP oturumu başlatıldı — Rank: ${session.rank}`);

      await send(chatId,
        `✅ *Giriş Başarılı!*\n\n` +
        `👤 Kullanıcı: @${username}\n` +
        `🎖 Rank: *${session.rank}*\n` +
        `⏱ Oturum: ${SESSION_TIMEOUT_MINUTES}dk\n\n` +
        `Menüyü açmak için: /menu`,
        { parse_mode: "Markdown" }
      );
      return;
    }

    // ── AUTH GATE ──
    if (!session.authed || isSessionExpired(session)) {
      if (text.startsWith("/")) {
        logSecurity(chatId, username, "UNAUTH_COMMAND", text.slice(0, 50));
      }
      await send(chatId, "🔐 Önce giriş yapın: /login <şifre>");
      return;
    }
    touchSession(session);

    // ── /menu ──
    if (text === "/menu") {
      logActivity(chatId, username, "MENU_OPEN");
      await send(chatId, `🌐 *NEXUS HUB — Ana Menü*\n\n👤 @${username} | 🎖 ${session.rank}`, {
        parse_mode: "Markdown",
        reply_markup: JSON.stringify(mainMenu(session.rank)),
      });
      return;
    }

    // ── /status ──
    if (text === "/status") {
      const activeKeys = Object.values(keys).filter(v => v.status === "ok").length;
      const activeSessions = Object.values(sessions).filter(s => s.authed && !isSessionExpired(s)).length;
      await send(chatId,
        `📊 *Sistem Durumu*\n\n` +
        `🔑 Aktif Key: ${activeKeys}\n` +
        `👥 Aktif Oturum: ${activeSessions}\n` +
        `🔧 Bakım: ${maintenance ? "AKTİF" : "Kapalı"}\n` +
        `📢 Duyuru: ${announcement || "Yok"}\n` +
        `🚨 Güvenlik Alarmı: ${securityAlerts.filter(s => Date.now() - new Date(s.time).getTime() < 3600000).length} (son 1 saat)`,
        { parse_mode: "Markdown" }
      );
      return;
    }

    // ── /myid ──
    if (text === "/myid") {
      await send(chatId, `🆔 Chat ID: \`${chatId}\``, { parse_mode: "Markdown" });
      return;
    }

    // ── PENDING ACTIONS (text input flows) ──
    const pa = pendingAction[chatId];
    if (pa) {
      // delete key
      if (pa.step === "delete_key") {
        const keyToDelete = text.trim().toUpperCase();
        delete pendingAction[chatId];
        if (keys[keyToDelete]) {
          delete keys[keyToDelete];
          logActivity(chatId, username, "KEY_DELETED", keyToDelete);
          await send(chatId, `✅ Key silindi: \`${keyToDelete}\``, { parse_mode: "Markdown" });
        } else {
          await send(chatId, "❌ Key bulunamadı.");
        }
        await send(chatId, "📋 Menü: /menu");
        return;
      }

      // announce
      if (pa.step === "announce") {
        delete pendingAction[chatId];
        if (text.toLowerCase() === "sil") {
          announcement = "";
          logActivity(chatId, username, "ANNOUNCE_CLEAR");
          await send(chatId, "📢 Duyuru silindi.");
        } else {
          announcement = text;
          logActivity(chatId, username, "ANNOUNCE_SET", text.slice(0, 80));
          await send(chatId, `📢 Duyuru ayarlandı:\n${text}`);
        }
        await send(chatId, "📋 Menü: /menu");
        return;
      }

      // ban
      if (pa.step === "ban_id") {
        pendingAction[chatId] = { step: "ban_reason", targetId: text.trim() };
        await send(chatId, "📝 Ban sebebini yazın:");
        return;
      }
      if (pa.step === "ban_reason") {
        const targetId = pa.targetId;
        const reason = text;
        delete pendingAction[chatId];
        bannedUsers[targetId] = { reason, bannedAt: new Date().toISOString(), bannedBy: username };
        // kill their session
        if (sessions[targetId]) {
          sessions[targetId].authed = false;
          sessions[targetId].rank = null;
        }
        logActivity(chatId, username, "USER_BANNED", `${targetId} — ${reason}`);
        logSecurity(chatId, username, "BAN_ISSUED", `Target: ${targetId} — ${reason}`);
        await send(chatId, `🚫 Kullanıcı banlandı: \`${targetId}\`\nSebep: ${reason}`, { parse_mode: "Markdown" });
        await send(chatId, "📋 Menü: /menu");
        return;
      }

      // unban
      if (pa.step === "unban_id") {
        const targetId = text.trim();
        delete pendingAction[chatId];
        if (bannedUsers[targetId]) {
          delete bannedUsers[targetId];
          logActivity(chatId, username, "USER_UNBANNED", targetId);
          await send(chatId, `✅ Unban yapıldı: \`${targetId}\``, { parse_mode: "Markdown" });
        } else {
          await send(chatId, "❌ Bu kullanıcı banlı değil.");
        }
        await send(chatId, "📋 Menü: /menu");
        return;
      }
    }

    // ── UNKNOWN COMMAND ──
    if (text.startsWith("/")) {
      await send(chatId,
        "📌 *Komutlar:*\n" +
        "/start — Hoşgeldin\n" +
        "/login <şifre> — Giriş\n" +
        "/menu — Ana menü\n" +
        "/status — Sistem durumu\n" +
        "/myid — Chat ID",
        { parse_mode: "Markdown" }
      );
      return;
    }
  }
});

// ─── API ENDPOINTS ──────────────────────────────────────────

// Health + status for scripts
app.get("/ping", (req, res) => {
  res.json({
    status: "ok",
    maintenance,
    announcement,
    uptime: process.uptime(),
    activeKeys: Object.values(keys).filter(v => v.status === "ok").length,
  });
});

// Key validation for Lua scripts
app.get("/check", (req, res) => {
  const key = (req.query.key || "").trim().toUpperCase();
  const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress || "?";

  if (!key) return res.json({ status: "error", message: "key parametresi eksik" });

  const entry = keys[key];
  if (!entry) {
    logSecurity("API", ip, "INVALID_KEY_CHECK", `Key: ${key.slice(0, 12)}...`);
    return res.json({ status: "invalid", message: "key bulunamadı" });
  }

  // expiry check
  if (entry.expire && Date.now() > entry.expire) {
    entry.status = "expired";
    logActivity("API", ip, "EXPIRED_KEY_CHECK", key);
    return res.json({ status: "expired", message: "key süresi dolmuş" });
  }

  logActivity("API", ip, "KEY_VERIFIED", `${key} | ${entry.rank} | ${entry.game}`);
  res.json({
    status: "ok",
    rank: entry.rank,
    game: entry.game,
    expire: entry.expire || null,
  });
});

// Security log endpoint (requires admin password header)
app.get("/admin/logs", (req, res) => {
  const auth = req.headers["x-admin-key"] || req.query.pw;
  if (auth !== ADMIN_PASSWORD) {
    return res.status(403).json({ error: "yetkisiz" });
  }
  res.json({
    activity: activityLog.slice(-50),
    security: securityAlerts.slice(-50),
    sessions: Object.entries(sessions).map(([id, s]) => ({
      chatId: id,
      authed: s.authed,
      rank: s.rank,
      lastActivity: s.lastActivity ? new Date(s.lastActivity).toISOString() : null,
      locked: isLocked(s),
    })),
    banned: bannedUsers,
  });
});

// ─── WEBHOOK SETUP ──────────────────────────────────────────
async function setupWebhook() {
  const url = `https://nexus-hub-b3gl.onrender.com/webhook/${BOT_TOKEN}`;
  try {
    const r = await fetch(`${API}/setWebhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    });
    const data = await r.json();
    console.log("Webhook:", data.ok ? "SET" : data.description);
  } catch (e) { console.error("Webhook error:", e.message); }
}

// ─── EXPIRED KEY CLEANUP (every 10 min) ─────────────────────
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of Object.entries(keys)) {
    if (v.expire && now > v.expire) v.status = "expired";
  }
}, 600000);

// ─── START ──────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`NEXUS HUB running on :${PORT}`);
  setupWebhook();
});
