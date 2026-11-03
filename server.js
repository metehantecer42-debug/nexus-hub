const express = require("express");
const app = express();
app.use(express.json());

const BOT_TOKEN    = process.env.BOT_TOKEN;
const ADMIN_ID     = Number(process.env.ADMIN_ID);
const ADMIN_PASS   = process.env.ADMIN_PASSWORD || "nexus2024"; // ENV'den değiştir
const API = `https://api.telegram.org/bot${BOT_TOKEN}`;

// ── VERİ ──────────────────────────────────────
let keys        = {};       // key → { rank, expire, game, created }
let users       = {};       // userId → { username, rank, banned, registeredAt }
let maintenance = { active: false, msg: "" };
let sessions    = {};       // userId → { step, data } — kayıt + flow state

// ── SABİTLER ─────────────────────────────────
const RANKS      = ["MOD","ADMIN","OWNER"];
const RANK_PERMS = {
    MOD:   ["listkeys","status","benim"],
    ADMIN: ["listkeys","status","benim","key","delexpired"],
    OWNER: ["listkeys","status","benim","key","delexpired","delkey","yetkiver","yasakla","maintenance","kullanicilar"],
};

function hasPerm(userId, perm) {
    const u = users[userId];
    if (!u || u.banned) return false;
    return (RANK_PERMS[u.rank] || []).includes(perm);
}

// ── KEY ───────────────────────────────────────
function randStr(n) {
    const c = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    let s=""; for(let i=0;i<n;i++) s+=c[Math.floor(Math.random()*c.length)];
    return s;
}
function randKey(rank, expire) {
    const code = randStr(6);
    let suffix = "PERM";
    if (expire !== 0) {
        const rem = expire - Date.now()/1000;
        if (rem<=86400)         suffix="DAY";
        else if(rem<=86400*7)   suffix="WEEK";
        else if(rem<=86400*30)  suffix="MONTH";
        else                    suffix="LONG";
    }
    return `NEXUS-${suffix}-${code}`;
}
function expireFrom(s) {
    if (!s || s==="sonsuz") return 0;
    const n = parseInt(s);
    if (s.endsWith("h")) return Date.now()/1000 + n*3600;
    if (s.endsWith("d")) return Date.now()/1000 + n*86400;
    if (s.endsWith("w")) return Date.now()/1000 + n*86400*7;
    if (s.endsWith("m")) return Date.now()/1000 + n*86400*30;
    return Date.now()/1000 + n*86400;
}
function expireLabel(exp) {
    if (exp===0) return "♾️ Sonsuz";
    const rem = exp - Date.now()/1000;
    if (rem<0)        return "❌ Süresi dolmuş";
    if (rem<3600)     return `${Math.floor(rem/60)} dakika`;
    if (rem<86400)    return `${Math.floor(rem/3600)} saat`;
    if (rem<86400*7)  return `${Math.floor(rem/86400)} gün`;
    if (rem<86400*30) return `${Math.floor(rem/86400/7)} hafta`;
    return `${Math.floor(rem/86400/30)} ay`;
}
function durLabel(s) {
    return {"1d":"1 Gün","2d":"2 Gün","7d":"1 Hafta","30d":"1 Ay","sonsuz":"Sonsuz"}[s] || s;
}
function gameLabel(g) {
    return {"all":"🎮 Tüm Oyunlar","kukirin":"🛴 Kukirin Life","buildweld":"🔧 Build and Weld"}[g] || g;
}
function rankEmoji(r) {
    return {"OWNER":"👑","ADMIN":"🛡️","MOD":"🔰"}[r] || "❓";
}

// ── TELEGRAM API ─────────────────────────────
async function send(chatId, text, extra={}) {
    await fetch(`${API}/sendMessage`, {
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({chat_id:chatId, text, parse_mode:"HTML", ...extra}),
    });
}
async function editMsg(chatId, msgId, text, extra={}) {
    await fetch(`${API}/editMessageText`, {
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({chat_id:chatId, message_id:msgId, text, parse_mode:"HTML", ...extra}),
    });
}
async function answerCb(id, text="") {
    await fetch(`${API}/answerCallbackQuery`, {
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({callback_query_id:id, text}),
    });
}
async function deleteMsg(chatId, msgId) {
    await fetch(`${API}/deleteMessage`, {
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({chat_id:chatId, message_id:msgId}),
    });
}

// ── BUTONLAR ─────────────────────────────────
function sureBtns() {
    return { inline_keyboard:[
        [{text:"1️⃣  1 Gün",   callback_data:"s_1d"},   {text:"2️⃣  2 Gün",  callback_data:"s_2d"}],
        [{text:"📅  1 Hafta",  callback_data:"s_7d"},   {text:"🗓️  1 Ay",   callback_data:"s_30d"}],
        [{text:"♾️  Sonsuz",   callback_data:"s_sonsuz"}],
        [{text:"❌  İptal",    callback_data:"iptal"}],
    ]};
}
function rankBtns(dur) {
    return { inline_keyboard:[
        [{text:"👤  USER",  callback_data:`r_USER_${dur}`},  {text:"🛡️  ADMIN", callback_data:`r_ADMIN_${dur}`}],
        [{text:"👑  OWNER", callback_data:`r_OWNER_${dur}`}],
        [{text:"🔙  Geri",  callback_data:"geri_sure"},       {text:"❌  İptal", callback_data:"iptal"}],
    ]};
}
function gameBtns(dur, rank) {
    return { inline_keyboard:[
        [{text:"🎮  Tüm Oyunlar",    callback_data:`g_all_${dur}_${rank}`}],
        [{text:"🛴  Kukirin Life",   callback_data:`g_kukirin_${dur}_${rank}`}],
        [{text:"🔧  Build and Weld", callback_data:`g_buildweld_${dur}_${rank}`}],
        [{text:"🔙  Geri",           callback_data:`geri_rank_${dur}`}, {text:"❌  İptal", callback_data:"iptal"}],
    ]};
}
function anaMenu() {
    return { inline_keyboard:[
        [{text:"🔑  Key Oluştur",    callback_data:"m_key"}],
        [{text:"📋  Keyler",         callback_data:"m_list"}, {text:"🧹  Süresiz Sil", callback_data:"m_delexp"}],
        [{text:"👥  Kullanıcılar",   callback_data:"m_users"},{text:"📊  Durum",        callback_data:"m_status"}],
        [{text:"🔧  Bakım Aç",       callback_data:"m_maint_on"},{text:"✅  Bakım Kapat",callback_data:"m_maint_off"}],
    ]};
}

// ── KAYIT AKIŞI ──────────────────────────────
async function startRegister(chatId) {
    sessions[chatId] = { step:"ask_username" };
    await send(chatId,
        `👋 <b>NEXUS HUB Yönetim Paneli</b>\n\n` +
        `Kayıt olmak için bilgilerini gir.\n\n` +
        `👤 Telegram kullanıcı adın nedir?\n` +
        `<i>(@ olmadan yaz — örn: metehan)</i>`
    );
}
async function handleRegister(chatId, userId, text) {
    const sess = sessions[chatId];
    if (!sess) return false;

    if (sess.step === "ask_username") {
        const username = text.replace("@","").trim();
        if (username.length < 3) {
            await send(chatId, "❌ Kullanıcı adı en az 3 karakter olmalı. Tekrar yaz:");
            return true;
        }
        sess.username = username;
        sess.step = "ask_password";
        await send(chatId,
            `👤 Kullanıcı adı: <b>@${username}</b>\n\n` +
            `🔐 Şimdi giriş şifreni yaz:\n` +
            `<i>(Şifre mesajın silinecek)</i>`
        );
        return true;
    }

    if (sess.step === "ask_password") {
        await deleteMsg(chatId, sess.lastMsgId);
        if (text !== ADMIN_PASS) {
            await send(chatId,
                `❌ <b>Yanlış şifre!</b>\n\n` +
                `Tekrar dene — doğru şifreyi gir:`,
            );
            return true;
        }
        // Kayıt tamamla
        const isOwner = userId === ADMIN_ID;
        users[userId] = {
            username: sess.username,
            rank: isOwner ? "OWNER" : "MOD",
            banned: false,
            registeredAt: Date.now()/1000,
        };
        delete sessions[chatId];
        await send(chatId,
            `✅ <b>Kayıt Tamamlandı!</b>\n\n` +
            `👤 Kullanıcı: @${users[userId].username}\n` +
            `${rankEmoji(users[userId].rank)} Rank: <b>${users[userId].rank}</b>\n\n` +
            `<i>Yetkin artırılması için @NexusOfficiall ile iletişime geç.</i>`,
            { reply_markup: anaMenu() }
        );
        return true;
    }

    return false;
}

// ── ANA PANEL GÖSTERİCİ ──────────────────────
async function showPanel(chatId, userId) {
    const u = users[userId];
    await send(chatId,
        `🎛️ <b>NEXUS HUB Paneli</b>\n\n` +
        `👤 @${u.username}  ${rankEmoji(u.rank)} <b>${u.rank}</b>\n` +
        `🔧 Bakım: ${maintenance.active?"AÇIK ⚠️":"KAPALI ✅"}\n` +
        `🔑 Aktif Key: ${Object.values(keys).filter(v=>v.expire===0||v.expire>Date.now()/1000).length}`,
        { reply_markup: anaMenu() }
    );
}

// ── WEBHOOK ───────────────────────────────────
app.post("/webhook", async (req, res) => {
    const body = req.body;

    // ── CALLBACK QUERY ──
    if (body.callback_query) {
        const cb     = body.callback_query;
        const chatId = cb.message.chat.id;
        const userId = cb.from.id;
        const msgId  = cb.message.message_id;
        const data   = cb.data;
        await answerCb(cb.id);

        const u = users[userId];
        if (!u) {
            await editMsg(chatId, msgId, "❌ Önce /start ile kayıt olman gerekiyor.");
            return res.send("ok");
        }
        if (u.banned) {
            await editMsg(chatId, msgId, "⛔ Erişimin engellendi.");
            return res.send("ok");
        }

        // İptal
        if (data === "iptal") {
            delete sessions[chatId];
            await editMsg(chatId, msgId, "❌ İşlem iptal edildi.", {reply_markup: anaMenu()});
            return res.send("ok");
        }

        // Ana menü aksiyonları
        if (data === "m_key") {
            if (!hasPerm(userId,"key")) {
                await editMsg(chatId, msgId, "❌ Bu işlem için yetkin yok.");
                return res.send("ok");
            }
            sessions[chatId] = { step:"key_sure" };
            await editMsg(chatId, msgId,
                "🔑 <b>Key Oluştur</b>\n\n⏱️ Süre seç:",
                { reply_markup: sureBtns() }
            );
            return res.send("ok");
        }

        if (data === "m_list") {
            if (!hasPerm(userId,"listkeys")) { await editMsg(chatId,msgId,"❌ Yetkin yok."); return res.send("ok"); }
            const list = Object.entries(keys).filter(([,v])=>v.expire===0||v.expire>Date.now()/1000);
            if (!list.length) {
                await editMsg(chatId, msgId, "📋 Aktif key yok.", {reply_markup:anaMenu()});
                return res.send("ok");
            }
            let t = `📋 <b>Aktif Keyler (${list.length})</b>\n\n`;
            for (const [k,v] of list) {
                t += `🔑 <code>${k}</code>\n`;
                t += `   ${rankEmoji(v.rank)} ${v.rank}  •  ⏱️ ${expireLabel(v.expire)}  •  ${gameLabel(v.game||"all")}\n\n`;
            }
            await editMsg(chatId, msgId, t, {reply_markup:anaMenu()});
            return res.send("ok");
        }

        if (data === "m_delexp") {
            if (!hasPerm(userId,"delexpired")) { await editMsg(chatId,msgId,"❌ Yetkin yok."); return res.send("ok"); }
            let n=0;
            for (const [k,v] of Object.entries(keys)) {
                if (v.expire!==0 && v.expire<Date.now()/1000) { delete keys[k]; n++; }
            }
            await editMsg(chatId, msgId, `🧹 ${n} süresi dolmuş key silindi.`, {reply_markup:anaMenu()});
            return res.send("ok");
        }

        if (data === "m_status") {
            if (!hasPerm(userId,"status")) { await editMsg(chatId,msgId,"❌ Yetkin yok."); return res.send("ok"); }
            const total  = Object.keys(keys).length;
            const active = Object.values(keys).filter(v=>v.expire===0||v.expire>Date.now()/1000).length;
            const regUsers = Object.keys(users).length;
            await editMsg(chatId, msgId,
                `📊 <b>NEXUS HUB Durumu</b>\n\n` +
                `🔧 Bakım: ${maintenance.active?"AÇIK ⚠️":"KAPALI ✅"}\n` +
                `🔑 Aktif key: ${active} / ${total}\n` +
                `👥 Kayıtlı kullanıcı: ${regUsers}`,
                {reply_markup:anaMenu()}
            );
            return res.send("ok");
        }

        if (data === "m_users") {
            if (!hasPerm(userId,"kullanicilar")) { await editMsg(chatId,msgId,"❌ Yetkin yok."); return res.send("ok"); }
            const list = Object.entries(users);
            if (!list.length) { await editMsg(chatId,msgId,"👥 Kayıtlı kullanıcı yok.",{reply_markup:anaMenu()}); return res.send("ok"); }
            let t = `👥 <b>Kayıtlı Kullanıcılar (${list.length})</b>\n\n`;
            for (const [uid, u2] of list) {
                t += `${rankEmoji(u2.rank)} @${u2.username}  <b>${u2.rank}</b>${u2.banned?" ⛔":""}\n`;
            }
            await editMsg(chatId, msgId, t, {reply_markup:anaMenu()});
            return res.send("ok");
        }

        if (data === "m_maint_on") {
            if (!hasPerm(userId,"maintenance")) { await editMsg(chatId,msgId,"❌ Yetkin yok."); return res.send("ok"); }
            maintenance = { active:true, msg:"Güncelleme yapılıyor, bekleyin..." };
            await editMsg(chatId, msgId, "🔧 <b>Bakım modu açıldı.</b>", {reply_markup:anaMenu()});
            return res.send("ok");
        }

        if (data === "m_maint_off") {
            if (!hasPerm(userId,"maintenance")) { await editMsg(chatId,msgId,"❌ Yetkin yok."); return res.send("ok"); }
            maintenance = { active:false, msg:"" };
            await editMsg(chatId, msgId, "✅ <b>Bakım modu kapandı.</b>", {reply_markup:anaMenu()});
            return res.send("ok");
        }

        // KEY AKIŞI — Süre
        if (data.startsWith("s_")) {
            if (!hasPerm(userId,"key")) { await editMsg(chatId,msgId,"❌ Yetkin yok."); return res.send("ok"); }
            const dur = data.replace("s_","");
            sessions[chatId] = { step:"key_rank", dur };
            await editMsg(chatId, msgId,
                `🔑 <b>Key Oluştur</b>\n\n` +
                `⏱️ Süre: <b>${durLabel(dur)}</b>\n\n` +
                `👑 Rank seç:`,
                { reply_markup: rankBtns(dur) }
            );
            return res.send("ok");
        }

        // KEY AKIŞI — Geri (süreye)
        if (data === "geri_sure") {
            sessions[chatId] = { step:"key_sure" };
            await editMsg(chatId, msgId,
                "🔑 <b>Key Oluştur</b>\n\n⏱️ Süre seç:",
                { reply_markup: sureBtns() }
            );
            return res.send("ok");
        }

        // KEY AKIŞI — Rank
        if (data.startsWith("r_")) {
            if (!hasPerm(userId,"key")) { await editMsg(chatId,msgId,"❌ Yetkin yok."); return res.send("ok"); }
            const parts = data.split("_");
            const rank  = parts[1];
            const dur   = parts[2];
            sessions[chatId] = { step:"key_game", dur, rank };
            await editMsg(chatId, msgId,
                `🔑 <b>Key Oluştur</b>\n\n` +
                `⏱️ Süre: <b>${durLabel(dur)}</b>\n` +
                `${rankEmoji(rank)} Rank: <b>${rank}</b>\n\n` +
                `🎮 Oyun seç:`,
                { reply_markup: gameBtns(dur, rank) }
            );
            return res.send("ok");
        }

        // KEY AKIŞI — Geri (ranka)
        if (data.startsWith("geri_rank_")) {
            const dur = data.replace("geri_rank_","");
            sessions[chatId] = { step:"key_rank", dur };
            await editMsg(chatId, msgId,
                `🔑 <b>Key Oluştur</b>\n\n` +
                `⏱️ Süre: <b>${durLabel(dur)}</b>\n\n` +
                `👑 Rank seç:`,
                { reply_markup: rankBtns(dur) }
            );
            return res.send("ok");
        }

        // KEY AKIŞI — Oyun → KEY OLUŞTUR
        if (data.startsWith("g_")) {
            if (!hasPerm(userId,"key")) { await editMsg(chatId,msgId,"❌ Yetkin yok."); return res.send("ok"); }
            const parts  = data.split("_");
            const game   = parts[1];
            const dur    = parts[2];
            const rank   = parts[3];
            const expire = expireFrom(dur);
            const key    = randKey(rank, expire);
            keys[key]    = { rank, expire, game, created:Date.now()/1000 };
            delete sessions[chatId];

            await editMsg(chatId, msgId,
                `✅ <b>Key Oluşturuldu!</b>\n\n` +
                `🔑 <code>${key}</code>\n\n` +
                `${rankEmoji(rank)} Rank: <b>${rank}</b>\n` +
                `⏱️ Süre: <b>${durLabel(dur)}</b>\n` +
                `🎮 Oyun: <b>${gameLabel(game)}</b>\n\n` +
                `📋 Kopyalayıp kullanıcıya gönder.`,
                { reply_markup: { inline_keyboard:[[
                    {text:"🔑 Yeni Key",  callback_data:"m_key"},
                    {text:"🏠 Ana Menü",  callback_data:"ana_menu"},
                ]]} }
            );
            return res.send("ok");
        }

        // Ana menüye dön
        if (data === "ana_menu") {
            const uu = users[userId];
            await editMsg(chatId, msgId,
                `🎛️ <b>NEXUS HUB Paneli</b>\n\n` +
                `👤 @${uu.username}  ${rankEmoji(uu.rank)} <b>${uu.rank}</b>\n` +
                `🔧 Bakım: ${maintenance.active?"AÇIK ⚠️":"KAPALI ✅"}\n` +
                `🔑 Aktif Key: ${Object.values(keys).filter(v=>v.expire===0||v.expire>Date.now()/1000).length}`,
                { reply_markup: anaMenu() }
            );
            return res.send("ok");
        }

        return res.send("ok");
    }

    // ── NORMAL MESAJLAR ──
    const msg = body.message;
    if (!msg || !msg.text) return res.send("ok");

    const chatId  = msg.chat.id;
    const userId  = msg.from.id;
    const text    = msg.text.trim();
    const lower   = text.toLowerCase();

    // Şifre mesajı → ata sessiona
    if (sessions[chatId]?.step === "ask_password") {
        sessions[chatId].lastMsgId = msg.message_id;
    }

    // Kayıt akışı
    if (sessions[chatId] && ["ask_username","ask_password"].includes(sessions[chatId].step)) {
        await handleRegister(chatId, userId, text);
        return res.send("ok");
    }

    // /start
    if (lower === "/start") {
        if (users[userId]) {
            if (users[userId].banned) {
                await send(chatId, "⛔ Erişimin engellendi. @NexusOfficiall");
                return res.send("ok");
            }
            await showPanel(chatId, userId);
            return res.send("ok");
        }
        await startRegister(chatId);
        return res.send("ok");
    }

    // /menu
    if (lower === "/menu") {
        if (!users[userId]) { await send(chatId,"❌ /start ile kayıt ol."); return res.send("ok"); }
        if (users[userId].banned) { await send(chatId,"⛔ Erişimin engellendi."); return res.send("ok"); }
        await showPanel(chatId, userId);
        return res.send("ok");
    }

    // Kayıtsız kullanıcı
    if (!users[userId]) {
        await send(chatId, "❌ Önce /start ile kayıt olman gerekiyor.");
        return res.send("ok");
    }
    if (users[userId].banned) {
        await send(chatId, "⛔ Erişimin engellendi. @NexusOfficiall");
        return res.send("ok");
    }

    // /benim
    if (lower === "/benim") {
        const u = users[userId];
        await send(chatId,
            `👤 <b>Profilim</b>\n\n` +
            `Kullanıcı adı: @${u.username}\n` +
            `${rankEmoji(u.rank)} Rank: <b>${u.rank}</b>\n` +
            `📅 Kayıt: ${new Date(u.registeredAt*1000).toLocaleDateString("tr-TR")}\n\n` +
            `📋 Yetkilerim: ${(RANK_PERMS[u.rank]||[]).join(", ")}`
        );
        return res.send("ok");
    }

    // /delkey
    if (lower.startsWith("/delkey")) {
        if (!hasPerm(userId,"delkey")) { await send(chatId,"❌ Yetkin yok."); return res.send("ok"); }
        const key = text.split(" ")[1]?.toUpperCase();
        if (!key || !keys[key]) { await send(chatId,"❌ Key bulunamadı."); return res.send("ok"); }
        delete keys[key];
        await send(chatId, `🗑️ Silindi: <code>${key}</code>`);
        return res.send("ok");
    }

    // /yetkiver @kullanici RANK
    if (lower.startsWith("/yetkiver")) {
        if (!hasPerm(userId,"yetkiver")) { await send(chatId,"❌ Yetkin yok."); return res.send("ok"); }
        const parts    = text.split(" ");
        const target   = parts[1]?.replace("@","");
        const newRank  = parts[2]?.toUpperCase();
        if (!target || !newRank || !RANKS.includes(newRank)) {
            await send(chatId,"❌ Kullanım: /yetkiver @kullanici MOD|ADMIN|OWNER"); return res.send("ok");
        }
        const found = Object.entries(users).find(([,u2])=>u2.username===target);
        if (!found) { await send(chatId,"❌ Kullanıcı bulunamadı."); return res.send("ok"); }
        users[found[0]].rank = newRank;
        await send(chatId, `✅ @${target} → ${rankEmoji(newRank)} <b>${newRank}</b>`);
        return res.send("ok");
    }

    // /yasakla @kullanici
    if (lower.startsWith("/yasakla")) {
        if (!hasPerm(userId,"yasakla")) { await send(chatId,"❌ Yetkin yok."); return res.send("ok"); }
        const target = text.split(" ")[1]?.replace("@","");
        if (!target) { await send(chatId,"❌ Kullanım: /yasakla @kullanici"); return res.send("ok"); }
        const found = Object.entries(users).find(([,u2])=>u2.username===target);
        if (!found) { await send(chatId,"❌ Kullanıcı bulunamadı."); return res.send("ok"); }
        users[found[0]].banned = true;
        await send(chatId, `⛔ @${target} yasaklandı.`);
        return res.send("ok");
    }

    // /yasakkalk @kullanici
    if (lower.startsWith("/yasakkalk")) {
        if (!hasPerm(userId,"yasakla")) { await send(chatId,"❌ Yetkin yok."); return res.send("ok"); }
        const target = text.split(" ")[1]?.replace("@","");
        if (!target) { await send(chatId,"❌ Kullanım: /yasakkalk @kullanici"); return res.send("ok"); }
        const found = Object.entries(users).find(([,u2])=>u2.username===target);
        if (!found) { await send(chatId,"❌ Kullanıcı bulunamadı."); return res.send("ok"); }
        users[found[0]].banned = false;
        await send(chatId, `✅ @${target} yasağı kaldırıldı.`);
        return res.send("ok");
    }

    // /maintenance on/off (metin)
    if (lower.startsWith("/maintenance")) {
        if (!hasPerm(userId,"maintenance")) { await send(chatId,"❌ Yetkin yok."); return res.send("ok"); }
        const parts = text.split(" ");
        const mode  = parts[1]?.toLowerCase();
        const m     = parts.slice(2).join(" ") || "Bakım yapılıyor...";
        if (mode==="on")       { maintenance={active:true,msg:m};   await send(chatId,`🔧 Bakım AÇIK\n📝 ${m}`); }
        else if(mode==="off")  { maintenance={active:false,msg:""}; await send(chatId,"✅ Bakım KAPALI"); }
        else await send(chatId,"/maintenance on [mesaj]\n/maintenance off");
        return res.send("ok");
    }

    // /key (metin ile)
    if (lower === "/key" || lower === "/addkey") {
        if (!hasPerm(userId,"key")) { await send(chatId,"❌ Yetkin yok."); return res.send("ok"); }
        sessions[chatId] = { step:"key_sure" };
        await send(chatId,
            "🔑 <b>Key Oluştur</b>\n\n⏱️ Süre seç:",
            { reply_markup: sureBtns() }
        );
        return res.send("ok");
    }

    // /help
    if (lower==="/help"||lower==="/yardim") {
        const u = users[userId];
        await send(chatId,
            `🤖 <b>NEXUS HUB Komutlar</b>\n\n` +
            `📋 /menu — Ana panel\n` +
            `🔑 /key — Key oluştur\n` +
            `👤 /benim — Profilim\n` +
            `🗑️ /delkey [KEY] — Key sil\n` +
            `👥 /yetkiver @ad RANK — Yetki ver\n` +
            `⛔ /yasakla @ad — Kullanıcı yasakla\n` +
            `✅ /yasakkalk @ad — Yasak kaldır\n` +
            `🔧 /maintenance on|off\n\n` +
            `👑 Rankın: <b>${u.rank}</b>\n` +
            `📱 @NexusOfficiall | 🛒 @NexusStoreOfficiall`
        );
        return res.send("ok");
    }

    // Bilinmeyen
    await send(chatId, "❓ /help yaz veya /menu ile panele git.");
    res.send("ok");
});

// ── SCRIPT ENDPOINTLERİ ───────────────────────
app.get("/ping", (req,res) => {
    res.json({status:maintenance.active?"maintenance":"online", msg:maintenance.msg});
});
app.get("/check", (req,res) => {
    if (maintenance.active) return res.json({status:"maintenance",msg:maintenance.msg});
    const key = req.query.key?.toUpperCase();
    if (!key) return res.json({status:"error"});
    const data = keys[key];
    if (!data) return res.json({status:"invalid"});
    if (data.expire!==0 && data.expire<Date.now()/1000) return res.json({status:"expired"});
    res.json({status:"valid", rank:data.rank, game:data.game||"all", expire:data.expire});
});
app.get("/", (req,res) => res.send("NEXUS HUB — Online ✅"));
app.listen(3000, ()=>console.log("NEXUS HUB çalışıyor 🚀"));
