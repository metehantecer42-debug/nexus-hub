const express = require("express");
const app = express();
app.use(express.json());

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID  = Number(process.env.ADMIN_ID);
const API = `https://api.telegram.org/bot${BOT_TOKEN}`;

let keys = {};
let maintenance = { active: false, msg: "" };
let pending = {}; // chatId → seçilen süre

// ── YARDIMCI ──────────────────────────────────
function randStr(n) {
    const c = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    let s = ""; for (let i=0;i<n;i++) s+=c[Math.floor(Math.random()*c.length)];
    return s;
}
function randKey(rank, expire) {
    const code = randStr(6);
    let suffix = "PERM";
    if (expire !== 0) {
        const rem = expire - Date.now()/1000;
        if (rem <= 86400)         suffix = "DAY";
        else if (rem <= 86400*7)  suffix = "WEEK";
        else if (rem <= 86400*30) suffix = "MONTH";
        else                      suffix = "LONG";
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
    if (exp===0) return "∞ Sonsuz";
    const rem = exp - Date.now()/1000;
    if (rem<0)       return "❌ Süresi dolmuş";
    if (rem<3600)    return `${Math.floor(rem/60)} dakika`;
    if (rem<86400)   return `${Math.floor(rem/3600)} saat`;
    if (rem<86400*7) return `${Math.floor(rem/86400)} gün`;
    if (rem<86400*30)return `${Math.floor(rem/86400/7)} hafta`;
    return `${Math.floor(rem/86400/30)} ay`;
}
function durLabel(s) {
    const map = { "1d":"1 Gün","2d":"2 Gün","7d":"1 Hafta","30d":"1 Ay","sonsuz":"Sonsuz" };
    return map[s] || s;
}
function gameLabel(g) {
    const map = { all:"🎮 Tüm Oyunlar", kukirin:"🛴 Kukirin Life", buildweld:"🔧 Build and Weld" };
    return map[g] || g;
}

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
async function answerCallback(id, text="") {
    await fetch(`${API}/answerCallbackQuery`, {
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({callback_query_id:id, text}),
    });
}

// ── MENÜ BUTONLARI ────────────────────────────
function sureBtns() {
    return { inline_keyboard: [
        [
            {text:"1️⃣ 1 Gün",    callback_data:"sur_1d"},
            {text:"2️⃣ 2 Gün",    callback_data:"sur_2d"},
        ],
        [
            {text:"📅 1 Hafta",   callback_data:"sur_7d"},
            {text:"🗓 1 Ay",      callback_data:"sur_30d"},
        ],
        [{text:"♾️ Sonsuz",      callback_data:"sur_sonsuz"}],
        [{text:"❌ İptal",        callback_data:"iptal"}],
    ]};
}

function rankBtns(dur) {
    return { inline_keyboard: [
        [
            {text:"👤 USER",  callback_data:`rk_USER_${dur}`},
            {text:"🛡 ADMIN", callback_data:`rk_ADMIN_${dur}`},
        ],
        [{text:"👑 OWNER",   callback_data:`rk_OWNER_${dur}`}],
        [{text:"🔙 Geri",    callback_data:"key_geri"}],
        [{text:"❌ İptal",   callback_data:"iptal"}],
    ]};
}

function gameBtns(dur, rank) {
    return { inline_keyboard: [
        [{text:"🎮 Tüm Oyunlar",    callback_data:`gm_all_${dur}_${rank}`}],
        [{text:"🛴 Kukirin Life",    callback_data:`gm_kukirin_${dur}_${rank}`}],
        [{text:"🔧 Build and Weld", callback_data:`gm_buildweld_${dur}_${rank}`}],
        [{text:"🔙 Geri",           callback_data:`rk_geri_${dur}`}],
        [{text:"❌ İptal",          callback_data:"iptal"}],
    ]};
}

// ── WEBHOOK ────────────────────────────────────
app.post("/webhook", async (req, res) => {
    const body = req.body;

    // ── CALLBACK QUERY (buton tıklamaları) ──
    if (body.callback_query) {
        const cb    = body.callback_query;
        const chatId = cb.message.chat.id;
        const msgId  = cb.message.message_id;
        const data   = cb.data;

        if (cb.from.id !== ADMIN_ID) {
            await answerCallback(cb.id, "❌ Yetkisiz!");
            return res.send("ok");
        }

        await answerCallback(cb.id);

        // İptal
        if (data === "iptal") {
            delete pending[chatId];
            await editMsg(chatId, msgId, "❌ İşlem iptal edildi.");
            return res.send("ok");
        }

        // Süre seçimi
        if (data.startsWith("sur_")) {
            const dur = data.replace("sur_","");
            pending[chatId] = { dur };
            await editMsg(chatId, msgId,
                `⏱ <b>Süre:</b> ${durLabel(dur)}\n\n👑 Şimdi rank seç:`,
                { reply_markup: rankBtns(dur) }
            );
            return res.send("ok");
        }

        // Geri (süre seçimine dön)
        if (data === "key_geri") {
            await editMsg(chatId, msgId,
                "🔑 <b>Key Oluştur</b>\n\nSüre seç:",
                { reply_markup: sureBtns() }
            );
            return res.send("ok");
        }

        // Rank seçimi
        if (data.startsWith("rk_") && !data.startsWith("rk_geri")) {
            const parts = data.split("_");
            const rank  = parts[1];
            const dur   = parts[2];
            await editMsg(chatId, msgId,
                `⏱ Süre: ${durLabel(dur)}\n👑 Rank: ${rank}\n\n🎮 Oyun seç:`,
                { reply_markup: gameBtns(dur, rank) }
            );
            return res.send("ok");
        }

        // Rank'tan geri
        if (data.startsWith("rk_geri_")) {
            const dur = data.replace("rk_geri_","");
            await editMsg(chatId, msgId,
                `⏱ Süre: ${durLabel(dur)}\n\n👑 Rank seç:`,
                { reply_markup: rankBtns(dur) }
            );
            return res.send("ok");
        }

        // Oyun seçimi → KEY OLUŞTUR
        if (data.startsWith("gm_")) {
            const parts  = data.split("_");
            const game   = parts[1];
            const dur    = parts[2];
            const rank   = parts[3];
            const expire = expireFrom(dur);
            const key    = randKey(rank, expire);
            keys[key] = { rank, expire, game, created: Date.now()/1000 };

            await editMsg(chatId, msgId,
                `✅ <b>Key Oluşturuldu!</b>\n\n` +
                `🔑 <code>${key}</code>\n\n` +
                `👑 Rank: <b>${rank}</b>\n` +
                `⏱ Süre: <b>${durLabel(dur)}</b>\n` +
                `🎮 Oyun: <b>${gameLabel(game)}</b>\n\n` +
                `Bu keyi kopyalayıp kullanıcıya gönder.`
            );
            return res.send("ok");
        }

        return res.send("ok");
    }

    // ── NORMAL MESAJLAR ──
    const msg = body.message;
    if (!msg || !msg.text) return res.send("ok");
    const chatId = msg.chat.id;
    const text   = msg.text.trim().toLowerCase();

    if (msg.from.id !== ADMIN_ID) {
        await send(chatId, "❌ Yetkisiz erişim!\n📱 @NexusOfficiall");
        return res.send("ok");
    }

    // /key veya /addkey → inline menü
    if (text === "/key" || text === "/addkey") {
        await send(chatId,
            "🔑 <b>Key Oluştur</b>\n\nSüre seç:",
            { reply_markup: sureBtns() }
        );
        return res.send("ok");
    }

    // /delkey
    if (text.startsWith("/delkey")) {
        const key = msg.text.trim().split(" ")[1]?.toUpperCase();
        if (!key || !keys[key]) { await send(chatId,"❌ Key bulunamadı."); return res.send("ok"); }
        delete keys[key];
        await send(chatId, `🗑️ Silindi: <code>${key}</code>`);
        return res.send("ok");
    }

    // /listkeys
    if (text === "/listkeys") {
        const list = Object.entries(keys).filter(([,v])=>v.expire===0||v.expire>Date.now()/1000);
        if (!list.length) { await send(chatId,"📋 Aktif key yok."); return res.send("ok"); }
        let t = "📋 <b>Aktif Keyler:</b>\n\n";
        for (const [k,v] of list) {
            t += `🔑 <code>${k}</code>\n`;
            t += `   👑 ${v.rank}  •  ⏱ ${expireLabel(v.expire)}  •  ${gameLabel(v.game||"all")}\n\n`;
        }
        await send(chatId, t);
        return res.send("ok");
    }

    // /delexpired
    if (text === "/delexpired") {
        let n=0;
        for (const [k,v] of Object.entries(keys)) {
            if (v.expire!==0 && v.expire<Date.now()/1000) { delete keys[k]; n++; }
        }
        await send(chatId, `🧹 ${n} süresi dolmuş key silindi.`);
        return res.send("ok");
    }

    // /maintenance
    if (text.startsWith("/maintenance")) {
        const parts = msg.text.trim().split(" ");
        const mode  = parts[1]?.toLowerCase();
        const m     = parts.slice(2).join(" ") || "Bakım yapılıyor...";
        if (mode==="on")  { maintenance={active:true,msg:m};  await send(chatId,`🔧 Bakım AÇIK\n📝 ${m}`); }
        else if(mode==="off") { maintenance={active:false,msg:""}; await send(chatId,"✅ Bakım KAPALI"); }
        else await send(chatId,"/maintenance on [mesaj]\n/maintenance off");
        return res.send("ok");
    }

    // /status
    if (text === "/status") {
        const total  = Object.keys(keys).length;
        const active = Object.values(keys).filter(v=>v.expire===0||v.expire>Date.now()/1000).length;
        await send(chatId,
            `📊 <b>NEXUS HUB</b>\n\n` +
            `🔧 Bakım: ${maintenance.active?"AÇIK ⚠️":"KAPALI ✅"}\n` +
            `✅ Aktif key: ${active}\n` +
            `📦 Toplam: ${total}`
        );
        return res.send("ok");
    }

    // /help veya /start
    if (text==="/help"||text==="/start") {
        await send(chatId,
            `🤖 <b>NEXUS HUB Komutlar</b>\n\n` +
            `🔑 /key — Key oluştur (menülü)\n` +
            `🗑️ /delkey [KEY] — Key sil\n` +
            `📋 /listkeys — Aktif keyleri gör\n` +
            `🧹 /delexpired — Süresini doldurmuşları sil\n` +
            `🔧 /maintenance on [mesaj]\n` +
            `✅ /maintenance off\n` +
            `📊 /status\n\n` +
            `📱 @NexusOfficiall | 🛒 @NexusStoreOfficiall`
        );
        return res.send("ok");
    }

    await send(chatId, "❓ /help yaz.");
    res.send("ok");
});

// Script endpoint'leri
app.get("/ping", (req,res) => {
    res.json({status: maintenance.active?"maintenance":"online", msg:maintenance.msg});
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
