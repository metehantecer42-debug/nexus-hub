const express = require("express");
const app = express();
app.use(express.json());

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID  = Number(process.env.ADMIN_ID);
const API = `https://api.telegram.org/bot${BOT_TOKEN}`;

let keys = {};
let maintenance = { active: false, msg: "" };

function randStr(n) {
    const c = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    let s = "";
    for (let i = 0; i < n; i++) s += c[Math.floor(Math.random()*c.length)];
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

function expireFromStr(s) {
    if (!s || s === "sonsuz" || s === "0") return 0;
    const n = parseInt(s);
    if (s.endsWith("h")) return Date.now()/1000 + n*3600;
    if (s.endsWith("d")) return Date.now()/1000 + n*86400;
    if (s.endsWith("w")) return Date.now()/1000 + n*86400*7;
    if (s.endsWith("m")) return Date.now()/1000 + n*86400*30;
    return Date.now()/1000 + n*86400;
}

function expireLabel(exp) {
    if (exp === 0) return "∞ Sonsuz";
    const rem = exp - Date.now()/1000;
    if (rem < 0)      return "❌ Süresi dolmuş";
    if (rem < 3600)   return `${Math.floor(rem/60)} dakika`;
    if (rem < 86400)  return `${Math.floor(rem/3600)} saat`;
    if (rem < 86400*7)  return `${Math.floor(rem/86400)} gün`;
    if (rem < 86400*30) return `${Math.floor(rem/86400/7)} hafta`;
    return `${Math.floor(rem/86400/30)} ay`;
}

async function sendMsg(chatId, text) {
    await fetch(`${API}/sendMessage`, {
        method: "POST",
        headers: {"Content-Type":"application/json"},
        body: JSON.stringify({chat_id: chatId, text, parse_mode: "HTML"}),
    });
}

app.post("/webhook", async (req, res) => {
    const msg = req.body.message;
    if (!msg || !msg.text) return res.send("ok");
    const chatId = msg.chat.id;
    const parts  = msg.text.trim().split(" ");
    const cmd    = parts[0].toLowerCase();

    if (msg.from.id !== ADMIN_ID) {
        await sendMsg(chatId, "❌ Yetkisiz erişim!\n📱 @NexusOfficiall");
        return res.send("ok");
    }

    // /addkey [RANK] [SÜRE] [OYUN]
    // Süre: 1h, 1d, 7d, 1w, 1m, sonsuz
    // Oyun: kukirin, buildweld, all (varsayılan: all)
    if (cmd === "/addkey") {
        const rank   = (parts[1] || "USER").toUpperCase();
        const expire = expireFromStr(parts[2] || "1d");
        const game   = (parts[3] || "all").toLowerCase();

        if (!["OWNER","ADMIN","USER"].includes(rank)) {
            await sendMsg(chatId, "❌ Rank: OWNER / ADMIN / USER\n\nÖrnek:\n/addkey USER 1d\n/addkey USER 1w kukirin\n/addkey ADMIN 1m all");
            return res.send("ok");
        }

        const key = randKey(rank, expire);
        keys[key] = {
            rank,
            expire,
            game,
            created: Date.now()/1000
        };

        const gameLabel = game === "all" ? "🎮 Tüm Oyunlar" :
                          game === "kukirin" ? "🛴 Kukirin Life" :
                          game === "buildweld" ? "🔧 Build and Weld" : game;

        await sendMsg(chatId,
            `✅ <b>Key oluşturuldu!</b>\n\n` +
            `🔑 <code>${key}</code>\n` +
            `👑 Rank: <b>${rank}</b>\n` +
            `⏱ Süre: <b>${expireLabel(expire)}</b>\n` +
            `${gameLabel}\n\n` +
            `Kopyalayıp kullanıcıya gönder.`
        );

    } else if (cmd === "/delkey") {
        const key = parts[1]?.toUpperCase();
        if (!key || !keys[key]) {
            await sendMsg(chatId, "❌ Key bulunamadı.");
            return res.send("ok");
        }
        delete keys[key];
        await sendMsg(chatId, `🗑️ Silindi: <code>${key}</code>`);

    } else if (cmd === "/listkeys") {
        const list = Object.entries(keys);
        if (!list.length) {
            await sendMsg(chatId, "📋 Aktif key yok.");
            return res.send("ok");
        }
        let text = "📋 <b>Keyler:</b>\n\n";
        for (const [k, v] of list) {
            const expired = v.expire !== 0 && v.expire < Date.now()/1000;
            if (!expired) {
                const gameLabel = v.game === "all" ? "🎮 Tüm" :
                                  v.game === "kukirin" ? "🛴 Kukirin" :
                                  v.game === "buildweld" ? "🔧 Build" : v.game;
                text += `🔑 <code>${k}</code>\n`;
                text += `   👑 ${v.rank}  •  ⏱ ${expireLabel(v.expire)}  •  ${gameLabel}\n\n`;
            }
        }
        await sendMsg(chatId, text || "📋 Aktif key yok.");

    } else if (cmd === "/delexpired") {
        let deleted = 0;
        for (const [k, v] of Object.entries(keys)) {
            if (v.expire !== 0 && v.expire < Date.now()/1000) {
                delete keys[k];
                deleted++;
            }
        }
        await sendMsg(chatId, `🧹 ${deleted} süresi dolmuş key silindi.`);

    } else if (cmd === "/maintenance") {
        const mode = parts[1]?.toLowerCase();
        const customMsg = parts.slice(2).join(" ") || "Bakım yapılıyor, bekleyin...";
        if (mode === "on") {
            maintenance = {active: true, msg: customMsg};
            await sendMsg(chatId, `🔧 Bakım AÇIK\n📝 ${customMsg}`);
        } else if (mode === "off") {
            maintenance = {active: false, msg: ""};
            await sendMsg(chatId, "✅ Bakım KAPALI — sistem online");
        } else {
            await sendMsg(chatId, "/maintenance on [mesaj]\n/maintenance off");
        }

    } else if (cmd === "/status") {
        const total  = Object.keys(keys).length;
        const active = Object.values(keys).filter(v => v.expire===0 || v.expire>Date.now()/1000).length;
        await sendMsg(chatId,
            `📊 <b>NEXUS HUB Durumu</b>\n\n` +
            `🔧 Bakım: ${maintenance.active ? "AÇIK ⚠️" : "KAPALI ✅"}\n` +
            `✅ Aktif key: ${active}\n` +
            `📦 Toplam key: ${total}\n` +
            `❌ Süresi dolmuş: ${total - active}`
        );

    } else if (cmd === "/help") {
        await sendMsg(chatId,
            `🤖 <b>NEXUS HUB Komutlar</b>\n\n` +
            `<b>Key Oluştur:</b>\n` +
            `/addkey [RANK] [SÜRE] [OYUN]\n\n` +
            `<b>Rank:</b> USER / ADMIN / OWNER\n\n` +
            `<b>Süre:</b>\n` +
            `  1h → 1 saat → NEXUS-DAY-XXXXXX\n` +
            `  1d → 1 gün  → NEXUS-DAY-XXXXXX\n` +
            `  1w → 1 hafta → NEXUS-WEEK-XXXXXX\n` +
            `  1m → 1 ay   → NEXUS-MONTH-XXXXXX\n` +
            `  sonsuz      → NEXUS-PERM-XXXXXX\n\n` +
            `<b>Oyun:</b>\n` +
            `  all → tüm oyunlar (varsayılan)\n` +
            `  kukirin → Kukirin Life\n` +
            `  buildweld → Build and Weld\n\n` +
            `<b>Örnekler:</b>\n` +
            `/addkey USER 1d\n` +
            `/addkey USER 1w kukirin\n` +
            `/addkey ADMIN 1m all\n` +
            `/addkey OWNER sonsuz\n\n` +
            `<b>Diğer:</b>\n` +
            `/delkey [KEY]\n` +
            `/listkeys\n` +
            `/delexpired\n` +
            `/maintenance on [mesaj]\n` +
            `/maintenance off\n` +
            `/status\n\n` +
            `📱 @NexusOfficiall`
        );

    } else {
        await sendMsg(chatId, "❓ Bilinmiyor. /help yaz.");
    }

    res.send("ok");
});

// Script endpoint'leri
app.get("/ping", (req, res) => {
    res.json({
        status: maintenance.active ? "maintenance" : "online",
        msg: maintenance.msg
    });
});

app.get("/check", (req, res) => {
    if (maintenance.active) {
        return res.json({status: "maintenance", msg: maintenance.msg});
    }
    const key = req.query.key?.toUpperCase();
    if (!key) return res.json({status: "error"});
    const data = keys[key];
    if (!data) return res.json({status: "invalid"});
    if (data.expire !== 0 && data.expire < Date.now()/1000) {
        return res.json({status: "expired"});
    }
    res.json({
        status: "valid",
        rank: data.rank,
        game: data.game || "all",
        expire: data.expire
    });
});

app.get("/", (req, res) => res.send("NEXUS HUB API — Online ✅"));

app.listen(3000, () => console.log("NEXUS HUB çalışıyor 🚀"));
