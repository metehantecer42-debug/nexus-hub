// ═══════════════════════════════════════════════════════════════
//  NEXUS HUB v2.1 — Telegram Bot + Key API Server
//  Built by Olivia — https://discord.gg/ojailbreaks
//  Kullanıcı bazlı giriş sistemi
// ═══════════════════════════════════════════════════════════════

const express = require("express");
const crypto = require("crypto");
const app = express();
app.use(express.json());

// ─── ENV ────────────────────────────────────────────────────
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = process.env.ADMIN_ID || "8961529079";
const PORT = process.env.PORT || 3000;
const API = `https://api.telegram.org/bot${BOT_TOKEN}`;

// ─── IN-MEMORY STATE ────────────────────────────────────────
// users: chatId -> { username, password, rank, createdAt, createdBy }
// OWNER auto-seeded on first /start from ADMIN_ID
let users = {};
let keys = {};
let sessions = {};       // chatId -> { authed, rank, lastActivity, loginAttempts, lockedUntil }
let activityLog = [];
let maintenance = false;
let announcement = "";
let bannedUsers = {};
let securityAlerts = [];

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

function logActivity(chatId, username, action, detail = "") {
  activityLog.push({ time: new Date().toISOString(), chatId: String(chatId), username: username || "?", action, detail });
  if (activityLog.length > 500) activityLog.shift();
}

function logSecurity(chatId, username, type, detail = "") {
  const entry = { time: new Date().toISOString(), chatId: String(chatId), username: username || "?", type, detail };
  securityAlerts.push(entry);
  if (securityAlerts.length > 200) securityAlerts.shift();
  if (type === "BRUTE_FORCE" || type === "BANNED_ACCESS") {
    send(ADMIN_ID, `🚨 *GÜVENLİK ALARMI*\n\nTip: \`${type}\`\nKullanıcı: @${username || "?"} (${chatId})\nDetay: ${detail}`, { parse_mode: "Markdown" });
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

async function answerCb(cbId, text = "") {
  try {
    await fetch(`${API}/answerCallbackQuery`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ callback_query_id: cbId, text }),
    });
  } catch (e) {}
}

// ─── KEYBOARDS ──────────────────────────────────────────────
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
    rows.push([{ text: "👤 Kullanıcılar", callback_data: "view_users" }]);
  }
  if (rankLevel(rank) >= RANKS.OWNER) {
    rows.push([{ text: "➕ Kullanıcı Ekle", callback_data: "add_user_prompt" }]);
    rows.push([{ text: "🗑 Kullanıcı Sil", callback_data: "del_user_prompt" }]);
    rows.push([{ text: "🎖 Rank Değiştir", callback_data: "change_rank_prompt" }]);
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

// ─── PENDING STATE ──────────────────────────────────────────
let pending = {};

// ─── WEBHOOK ────────────────────────────────────────────────
app.post(`/webhook/${BOT_TOKEN}`, async (req, res) => {
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

    await answerCb(cb.id);

    if (!session.authed || isSessionExpired(session)) {
      if (data !== "logout") {
        await send(chatId, "⚠️ Oturum dolmuş. /login <kullanıcıadı> <şifre>");
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

    // VIEW USERS
    if (data === "view_users") {
      const userList = Object.entries(users);
      if (!userList.length) {
        await editMsg(chatId, msgId, "👤 Kayıtlı kullanıcı yok.", { reply_markup: JSON.stringify(mainMenu(session.rank)) });
        return;
      }
      let txt = "👤 *Kayıtlı Kullanıcılar:*\n\n";
      for (const [id, u] of userList) {
        txt += `🔹 \`${id}\` — @${u.username} — *${u.rank}*\n`;
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
      const last20 = activityLog.slice(-20).reverse();
      let txt = last20.length ? "📊 *Son Aktiviteler:*\n\n" : "📊 Henüz aktivite yok.";
      for (const e of last20) txt += `\`${e.time.slice(11,19)}\` @${e.username} — *${e.action}*${e.detail ? `\n   ${e.detail}` : ""}\n`;
      await editMsg(chatId, msgId, txt, { parse_mode: "Markdown", reply_markup: JSON.stringify(mainMenu(session.rank)) });
      return;
    }

    // SECURITY LOG
    if (data === "view_security") {
      const last20 = securityAlerts.slice(-20).reverse();
      let txt = last20.length ? "🚨 *Güvenlik:*\n\n" : "🚨 Kayıt yok.";
      for (const e of last20) txt += `\`${e.time.slice(11,19)}\` [${e.type}] @${e.username}\n   ${e.detail}\n\n`;
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
        txt += `🔹 \`${id}\` @${u ? u.username : "?"} — *${s.rank}* — ${ago}dk\n`;
      }
      await editMsg(chatId, msgId, txt, { parse_mode: "Markdown", reply_markup: JSON.stringify(mainMenu(session.rank)) });
      return;
    }

    return;
  }

  // ── TEXT MESSAGES ──
  if (body.message && body.message.text) {
    const msg = body.message;
    const chatId = msg.chat.id;
    const text = msg.text.trim();
    const tgUser = msg.from.username || msg.from.first_name || "?";
    const session = getSession(chatId);

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
      await send(chatId,
        `╔══════════════════════════════╗\n` +
        `║       🌐 NEXUS HUB 🌐       ║\n` +
        `╠══════════════════════════════╣\n` +
        `║  Key Yönetim Sistemi v2.1    ║\n` +
        `║  Kullanıcı Bazlı Giriş      ║\n` +
        `╚══════════════════════════════╝\n\n` +
        (isOwner
          ? `👑 *OWNER tespit edildi!*\nOtomatik giriş: /login\n\n`
          : `🔐 Giriş: /login <kullanıcıadı> <şifre>\n\n`) +
        `⚠️ ${MAX_LOGIN_ATTEMPTS} yanlış = ${LOCKOUT_MINUTES}dk kilit`,
        { parse_mode: "Markdown" }
      );
      return;
    }

    // /login
    if (text.startsWith("/login")) {
      const parts = text.split(/\s+/);

      if (isLocked(session)) {
        const rem = Math.ceil((session.lockedUntil - Date.now()) / 60000);
        logSecurity(chatId, tgUser, "LOCKED_ATTEMPT", `${rem}dk`);
        await send(chatId, `🔒 Kilitli. ${rem}dk bekleyin.`);
        return;
      }

      // OWNER — no password needed, just /login
      if (String(chatId) === String(ADMIN_ID)) {
        session.authed = true;
        session.rank = "OWNER";
        session.loginAttempts = 0;
        session.lockedUntil = 0;
        touchSession(session);
        logActivity(chatId, tgUser, "LOGIN_OWNER");
        await send(chatId,
          `✅ *OWNER Giriş Başarılı!*\n\n👑 @${tgUser}\n⏱ Oturum: ${SESSION_TIMEOUT_MINUTES}dk\n\n/menu ile devam et.`,
          { parse_mode: "Markdown" });
        return;
      }

      // Normal users: /login <username> <password>
      const uname = parts[1] || "";
      const pw = parts[2] || "";

      if (!uname || !pw) {
        await send(chatId, "⚠️ Kullanım: /login <kullanıcıadı> <şifre>");
        return;
      }

      // find user by chatId or by username
      let foundId = null;
      let foundUser = null;
      for (const [id, u] of Object.entries(users)) {
        if (u.username.toLowerCase() === uname.toLowerCase()) {
          foundId = id; foundUser = u; break;
        }
      }

      if (!foundUser || foundUser.password !== pw) {
        session.loginAttempts++;
        const rem = MAX_LOGIN_ATTEMPTS - session.loginAttempts;
        logSecurity(chatId, tgUser, "FAILED_LOGIN", `user: ${uname} | ${session.loginAttempts}/${MAX_LOGIN_ATTEMPTS}`);
        if (session.loginAttempts >= MAX_LOGIN_ATTEMPTS) {
          session.lockedUntil = Date.now() + LOCKOUT_MINUTES * 60000;
          logSecurity(chatId, tgUser, "BRUTE_FORCE", `${MAX_LOGIN_ATTEMPTS} deneme — kilitlendi`);
          await send(chatId, `🚨 ${LOCKOUT_MINUTES}dk kilitlendi!`);
          return;
        }
        await send(chatId, `❌ Yanlış kullanıcı adı veya şifre. Kalan: ${rem}`);
        return;
      }

      // Check if chatId matches (user must login from their own account)
      // OR allow login from any chat but bind to the registered chatId
      session.authed = true;
      session.rank = foundUser.rank;
      session.loginAttempts = 0;
      session.lockedUntil = 0;
      touchSession(session);
      logActivity(chatId, tgUser, "LOGIN_OK", `as ${uname} | rank: ${foundUser.rank}`);
      logSecurity(chatId, tgUser, "LOGIN_OK", `${uname} — ${foundUser.rank}`);
      await send(chatId,
        `✅ *Giriş Başarılı!*\n\n👤 ${uname}\n🎖 *${foundUser.rank}*\n⏱ ${SESSION_TIMEOUT_MINUTES}dk\n\n/menu`,
        { parse_mode: "Markdown" });
      return;
    }

    // AUTH GATE
    if (!session.authed || isSessionExpired(session)) {
      if (text.startsWith("/")) logSecurity(chatId, tgUser, "UNAUTH_CMD", text.slice(0, 40));
      await send(chatId, "🔐 Giriş yapın: /login <kullanıcıadı> <şifre>");
      return;
    }
    touchSession(session);

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

    // ── PENDING TEXT INPUT FLOWS ──
    const pa = pending[chatId];
    if (pa) {
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

// ─── API ────────────────────────────────────────────────────
app.get("/ping", (req, res) => {
  res.json({ status: "ok", maintenance, announcement, uptime: process.uptime(), keys: Object.values(keys).filter(v => v.status === "ok").length, users: Object.keys(users).length });
});

app.get("/check", (req, res) => {
  const key = (req.query.key || "").trim().toUpperCase();
  const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress || "?";
  if (!key) return res.json({ status: "error", message: "key yok" });
  const entry = keys[key];
  if (!entry) {
    logSecurity("API", ip, "INVALID_KEY", key.slice(0, 12));
    return res.json({ status: "invalid" });
  }
  if (entry.expire && Date.now() > entry.expire) {
    entry.status = "expired";
    return res.json({ status: "expired" });
  }
  logActivity("API", ip, "KEY_OK", `${key} | ${entry.rank} | ${entry.game}`);
  res.json({ status: "ok", rank: entry.rank, game: entry.game, expire: entry.expire || null });
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
app.listen(PORT, () => { console.log(`NEXUS H
