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
    for (let i = 0; i < n; i++) s += c[Math.floor(Math.random() * c.length)];
    return s;
}
function randKey(rank) {
    return `NEXUS-${rank[0]}-${randStr(4)}-${randStr(4)}-${randStr(4)}`;
}
function expireFromStr(s) {
    if (!s || s === "sonsuz" || s === "0") return 0;
    const n = parseInt(s);
    if (s.endsWith("h")) return Date.now()/1000 + n*3600;
    if (s.endsWith("w")) return Date.now()/1000 + n*86400*7;
    return Date.now()/1000 + n*86400;
}
function expireLabel(exp) {
    if (exp === 0) return "∞ Sonsuz";
    const rem = exp - Date.now()/1000;
    if (rem < 0) return "❌ Süresi dolmuş";
    if (rem < 3600) return `${Math.floor(rem/60)} dakika`;
    if (rem < 86400) return `${Math.floor(rem/3600)} saat`;
    return `${Math.floor(rem/86400)} gün`;
}
async function sendMsg(chatId, text) {
    await fetch(`${API}/sendMessage`, {
        method: "POST",
        headers: {"Content-Type":"application/json"},
        body: JSON.stringify({chat_id:chatId, text, parse_mode:"HTML"}),
    });
}

app.post("/webhook", async (req, res) => {
    const msg = req.body.message;
    if (!msg || !msg.text) return res.send("ok");
    const chatId = msg.chat.id;
    const parts  = msg.text.trim().split(" ");
    const cmd    = parts[0].toLowerCase();
    if (msg.from.id !== ADMIN_ID) {
        await sendMsg(chatId, "❌ Yetkisiz!\n📱 @NexusOfficiall");
        return res.send("ok");
    }
    if (cmd === "/addkey") {
        const rank   = (parts[1] || "USER").toUpperCase();
        const expire = expireFromStr(parts[2] || "1d");
        if (!["OWNER","ADMIN","USER"].includes(rank)) {
            await sendMsg(chatId, "❌ Rank: OWNER / ADMIN / USER");
            return res.send("ok");
        }
        const key = randKey(rank);
        keys[key] = {rank, expire, created: Date.now()/1000};
        await sendMsg(chatId, `✅ Key oluşturuldu!\n\n🔑 <code>${key}</code>\n👑 Rank: ${rank}\n⏱ Süre: ${expireLabel(expire)}`);
    } else if (cmd === "/delkey") {
        const key = parts[1]?.toUpperCase();
        if (!key || !keys[key]) { await sendMsg(chatId,"❌ Bulunamadı."); return res.send("ok"); }
        delete keys[key];
        await sendMsg(chatId, `🗑️ Silindi: <code>${key}</code>`);
    } else if (cmd === "/listkeys") {
        const list = Object.entries(keys);
        if (!list.length) { await sendMsg(chatId,"📋 Aktif key yok."); return res.send("ok"); }
        let text = "📋 <b>Keyler:</b>\n\n";
        for (const [k,v] of list) text += `🔑 <code>${k}</code>\n   👑 ${v.rank}  •  ⏱ ${expireLabel(v.expire)}\n\n`;
        await sendMsg(chatId, text);
    } else if (cmd === "/maintenance") {
        const mode = parts[1]?.toLowerCase();
        const msg2 = parts.slice(2).join(" ") || "Bakım yapılıyor...";
        if (mode === "on")  { maintenance={active:true,msg:msg2}; await sendMsg(chatId,`🔧 Bakım AÇIK\n${msg2}`); }
        else if (mode==="off") { maintenance={active:false,msg:""}; await sendMsg(chatId,"✅ Bakım KAPALI"); }
        else await sendMsg(chatId,"/maintenance on [mesaj]\n/maintenance off");
    } else if (cmd === "/status") {
        const aktif = Object.values(keys).filter(v=>v.expire===0||v.expire>Date.now()/1000).length;
        await sendMsg(chatId, `📊 NEXUS HUB\n\n🔧 Bakım: ${maintenance.active?"AÇIK ⚠️":"KAPALI ✅"}\n✅ Aktif: ${aktif}\n📦 Toplam: ${Object.keys(keys).length}`);
    } else if (cmd === "/help") {
        await sendMsg(chatId, `🤖 <b>Komutlar</b>\n\n/addkey [RANK] [SÜRE]\n  Örnek: /addkey USER 1d\n  Örnek: /addkey OWNER sonsuz\n\n/delkey [KEY]\n/listkeys\n/maintenance on [mesaj]\n/maintenance off\n/status\n\n📱 @NexusOfficiall`);
    } else {
        await sendMsg(chatId,"❓ /help yaz.");
    }
    res.send("ok");
});

app.get("/ping", (req,res) => {
    res.json({status: maintenance.active?"maintenance":"online", msg: maintenance.msg});
});

app.get("/check", (req,res) => {
    if (maintenance.active) return res.json({status:"maintenance",msg:maintenance.msg});
    const key = req.query.key?.toUpperCase();
    if (!key) return res.json({status:"error"});
    const data = keys[key];
    if (!data) return res.json({status:"invalid"});
    if (data.expire!==0 && data.expire<Date.now()/1000) return res.json({status:"expired"});
    res.json({status:"valid", rank:data.rank, expire:data.expire});
});

app.get("/", (req,res) => res.send("NEXUS HUB — Online ✅"));

app.listen(3000, () => console.log("Çalışıyor!"));
