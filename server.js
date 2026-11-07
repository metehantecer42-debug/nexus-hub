// NEXUS HUB — server.js
// Telegram: @NexusStoreOfficiall

const express = require('express');
const app = express();
app.use(express.json());

const TOKEN    = process.env.BOT_TOKEN;
const ADMIN_ID = process.env.ADMIN_ID;
const ADMIN_PW = process.env.ADMIN_PASSWORD || 'nexus2024';
const PORT     = process.env.PORT || 3000;
const BASE_URL = `https://api.telegram.org/bot${TOKEN}`;

// ══════════════════════════════════════
// VERİ DEPOLAMA (bellek - ücretsiz plan)
// ══════════════════════════════════════
const users = {};       // { telegramId: { username, rank, banned, registered } }
const keys  = {};       // { keyStr: { rank, game, expire, used, usedBy } }
const sessions = {};    // { telegramId: { step, data... } }
let maintenance = false;
let announcementMsg = '';

// ══════════════════════════════════════
// YARDIMCI
// ══════════════════════════════════════
function randomKey(prefix) {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let r = '';
    for (let i = 0; i < 6; i++) r += chars[Math.floor(Math.random() * chars.length)];
    return `NEXUS-${prefix}-${r}`;
}

function expireMs(type) {
    const map = { '1G': 86400000, '2G': 172800000, '1H': 604800000, '1A': 2592000000, 'SONSUZ': null };
    return map[type] || null;
}

function keyPrefix(type) {
    const map = { '1G': 'DAY', '2G': 'DAY2', '1H': 'WEEK', '1A': 'MONTH', 'SONSUZ': 'PERM' };
    return map[type] || 'PERM';
}

function rankLabel(r) {
    const m = { OWNER: '👑 OWNER', ADMIN: '🛡 ADMIN', MOD: '🔰 MOD', USER: '👤 USER' };
    return m[r] || '👤 USER';
}

function gameLabel(g) {
    const m = { all: '🌍 Tüm Oyunlar', kukirin: '🌾 Kukirin', buildweld: '🔧 Build & Weld', sdrp: '🏙️ San Diego RP' };
    return m[g] || g;
}

function isOwner(id)  { return String(id) === String(ADMIN_ID) || (users[id] && users[id].rank === 'OWNER'); }
function isAdmin(id)  { return isOwner(id) || (users[id] && users[id].rank === 'ADMIN'); }
function isMod(id)    { return isAdmin(id) || (users[id] && users[id].rank === 'MOD'); }

// ══════════════════════════════════════
// TELEGRAM API
// ══════════════════════════════════════
async function tg(method, body) {
    const https = require('https');
    return new Promise((res, rej) => {
        const data = JSON.stringify(body);
        const req = https.request(`${BASE_URL}/${method}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
        }, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => res(JSON.parse(d))); });
        req.on('error', rej);
        req.write(data);
        req.end();
    });
}

function send(chatId, text, extra = {}) {
    return tg('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', ...extra });
}

function edit(chatId, msgId, text, extra = {}) {
    return tg('editMessageText', { chat_id: chatId, message_id: msgId, text, parse_mode: 'HTML', ...extra });
}

function deleteMsg(chatId, msgId) {
    return tg('deleteMessage', { chat_id: chatId, message_id: msgId });
}

// ══════════════════════════════════════
// KULLANICI KAYIT / GİRİŞ
// ══════════════════════════════════════
async function handleStart(msg) {
    const id  = msg.from.id;
    const uname = msg.from.username || msg.from.first_name || String(id);

    // İlk ADMIN_ID olanı OWNER yap
    if (String(id) === String(ADMIN_ID) && !users[id]) {
        users[id] = { username: uname, rank: 'OWNER', banned: false, registered: true };
    }

    if (users[id] && users[id].registered) {
        return showPanel(id, uname);
    }

    sessions[id] = { step: 'await_register_choice', username: uname };

    await send(id,
        `🎮 <b>NEXUS HUB</b>'a hoş geldin, <b>@${uname}</b>!\n\n` +
        `Devam etmek için bir seçenek seç:`,
        { reply_markup: { inline_keyboard: [
            [{ text: '📝 Kayıt Ol', callback_data: 'auth_register' }],
            [{ text: '🔑 Giriş Yap', callback_data: 'auth_login' }],
        ]}}
    );
}

async function showPanel(id, uname) {
    const u = users[id];
    const rank = u ? rankLabel(u.rank) : '👤 USER';
    await send(id,
        `✅ <b>Giriş başarılı!</b>\n\n👤 Kullanıcı: @${uname}\n${rank}\n\n<b>NEXUS HUB Paneli</b>`,
        { reply_markup: { inline_keyboard: [
            [{ text: '🔑 Key Oluştur', callback_data: 'panel_key' }],
            [{ text: '👤 Profilim',     callback_data: 'panel_profile' }],
            [{ text: '📢 Duyuru',       callback_data: 'panel_announce' }],
            [{ text: '⚙️ Yönetim',      callback_data: 'panel_admin' }],
        ]}}
    );
}

// ══════════════════════════════════════
// KEY OLUŞTURMA AKIŞI
// ══════════════════════════════════════
async function startKeyFlow(id, msgId) {
    if (!isMod(id)) return send(id, '❌ Yetersiz yetki.');
    sessions[id] = { step: 'key_sure', msgId };
    await edit(id, msgId,
        '🔑 <b>Key Oluştur</b>\n\nSüre seçin:',
        { reply_markup: { inline_keyboard: [
            [{ text: '1 Gün',   callback_data: 'ks_1G' },  { text: '2 Gün',  callback_data: 'ks_2G' }],
            [{ text: '1 Hafta', callback_data: 'ks_1H' },  { text: '1 Ay',   callback_data: 'ks_1A' }],
            [{ text: '♾ Sonsuz', callback_data: 'ks_SONSUZ' }],
            [{ text: '◀ Geri',  callback_data: 'panel_back' }],
        ]}}
    );
}

async function keyRankStep(id, msgId, sure) {
    sessions[id] = { step: 'key_rank', msgId, sure };
    await edit(id, msgId,
        `🔑 Süre: <b>${sure}</b>\n\nRank seçin:`,
        { reply_markup: { inline_keyboard: [
            [{ text: '👑 OWNER', callback_data: 'kr_OWNER' }, { text: '🛡 ADMIN', callback_data: 'kr_ADMIN' }],
            [{ text: '🔰 MOD',  callback_data: 'kr_MOD'   }, { text: '👤 USER',  callback_data: 'kr_USER'  }],
            [{ text: '◀ Geri',  callback_data: 'panel_key' }],
        ]}}
    );
}

async function keyGameStep(id, msgId, sure, rank) {
    sessions[id] = { step: 'key_game', msgId, sure, rank };
    await edit(id, msgId,
        `🔑 Süre: <b>${sure}</b> | Rank: <b>${rank}</b>\n\nOyun seçin:`,
        { reply_markup: { inline_keyboard: [
            [{ text: '🌍 Tüm Oyunlar',    callback_data: 'kg_all'      }],
            [{ text: '🌾 Kukirin',         callback_data: 'kg_kukirin'  }],
            [{ text: '🔧 Build & Weld',    callback_data: 'kg_buildweld'}],
            [{ text: '🏙️ San Diego RP',   callback_data: 'kg_sdrp'    }],
            [{ text: '◀ Geri',            callback_data: 'panel_key'   }],
        ]}}
    );
}

async function generateKey(id, msgId, sure, rank, game) {
    const prefix = keyPrefix(sure);
    const keyStr = randomKey(prefix);
    const expMs  = expireMs(sure);
    keys[keyStr] = {
        rank,
        game,
        expire: expMs ? Date.now() + expMs : null,
        used: false,
        usedBy: null,
    };
    sessions[id] = {};
    await edit(id, msgId,
        `✅ <b>Key Oluşturuldu!</b>\n\n` +
        `🔑 <code>${keyStr}</code>\n\n` +
        `⏳ Süre: ${sure}\n` +
        `🎖 Rank: ${rankLabel(rank)}\n` +
        `🎮 Oyun: ${gameLabel(game)}\n\n` +
        `Kopyalamak için koda tıkla.`,
        { reply_markup: { inline_keyboard: [
            [{ text: '◀ Panele Dön', callback_data: 'panel_back' }],
        ]}}
    );
}

// ══════════════════════════════════════
// CALLBACK HANDLER
// ══════════════════════════════════════
async function handleCallback(cb) {
    const id    = cb.from.id;
    const data  = cb.data;
    const msgId = cb.message.message_id;
    const uname = cb.from.username || cb.from.first_name || String(id);
    const sess  = sessions[id] || {};

    await tg('answerCallbackQuery', { callback_query_id: cb.id });

    // — Auth akışı —
    if (data === 'auth_register' || data === 'auth_login') {
        sessions[id] = { step: 'await_password', action: data, username: uname, pwMsgId: msgId };
        const m = await send(id, '🔒 Lütfen şifreyi gir:');
        sessions[id].promptMsgId = m.result.message_id;
        return;
    }

    // — Panel navigasyon —
    if (data === 'panel_back') return showPanel(id, uname);
    if (data === 'panel_key')  return startKeyFlow(id, msgId);

    if (data === 'panel_profile') {
        const u = users[id];
        return edit(id, msgId,
            `👤 <b>Profil</b>\n\n` +
            `Kullanıcı: @${uname}\n` +
            `Rank: ${rankLabel(u ? u.rank : 'USER')}\n` +
            `Kayıt: ✅`,
            { reply_markup: { inline_keyboard: [[{ text: '◀ Geri', callback_data: 'panel_back' }]] }}
        );
    }

    if (data === 'panel_announce') {
        if (!isAdmin(id)) return send(id, '❌ Yetersiz yetki.');
        sessions[id] = { step: 'await_announce', msgId };
        return send(id, '📢 Duyuru metnini gir (veya "temizle" yaz):');
    }

    if (data === 'panel_admin') {
        if (!isAdmin(id)) return send(id, '❌ Yetersiz yetki.');
        return edit(id, msgId,
            `⚙️ <b>Yönetim Paneli</b>\n\n` +
            `🔧 Bakım: ${maintenance ? '🔴 Aktif' : '🟢 Kapalı'}`,
            { reply_markup: { inline_keyboard: [
                [{ text: maintenance ? '🟢 Bakımı Kapat' : '🔴 Bakımı Aç', callback_data: 'admin_maint' }],
                [{ text: '◀ Geri', callback_data: 'panel_back' }],
            ]}}
        );
    }

    if (data === 'admin_maint') {
        if (!isAdmin(id)) return send(id, '❌ Yetersiz yetki.');
        maintenance = !maintenance;
        return edit(id, msgId,
            `⚙️ <b>Yönetim Paneli</b>\n\n🔧 Bakım: ${maintenance ? '🔴 Aktif' : '🟢 Kapalı'}`,
            { reply_markup: { inline_keyboard: [
                [{ text: maintenance ? '🟢 Bakımı Kapat' : '🔴 Bakımı Aç', callback_data: 'admin_maint' }],
                [{ text: '◀ Geri', callback_data: 'panel_back' }],
            ]}}
        );
    }

    // — Key akışı: süre —
    if (data.startsWith('ks_')) return keyRankStep(id, msgId, data.slice(3));
    // — Key akışı: rank —
    if (data.startsWith('kr_')) return keyGameStep(id, msgId, sess.sure, data.slice(3));
    // — Key akışı: oyun —
    if (data.startsWith('kg_')) return generateKey(id, msgId, sess.sure, sess.rank, data.slice(3));
}

// ══════════════════════════════════════
// MESAJ HANDLER
// ══════════════════════════════════════
async function handleMessage(msg) {
    const id    = msg.from.id;
    const text  = (msg.text || '').trim();
    const uname = msg.from.username || msg.from.first_name || String(id);
    const sess  = sessions[id] || {};

    // Komutlar
    if (text === '/start' || text === '/menu') return handleStart(msg);

    if (text.startsWith('/yetkiver ')) {
        if (!isAdmin(id)) return send(id, '❌ Yetersiz yetki.');
        const parts = text.split(' ');
        const target = parts[1]?.replace('@','');
        const rank   = parts[2]?.toUpperCase();
        const found  = Object.entries(users).find(([,u]) => u.username === target);
        if (!found) return send(id, '❌ Kullanıcı bulunamadı.');
        found[1].rank = rank;
        return send(id, `✅ @${target} → ${rankLabel(rank)}`);
    }

    if (text.startsWith('/yasakla ')) {
        if (!isAdmin(id)) return send(id, '❌ Yetersiz yetki.');
        const target = text.split(' ')[1]?.replace('@','');
        const found  = Object.entries(users).find(([,u]) => u.username === target);
        if (!found) return send(id, '❌ Bulunamadı.');
        found[1].banned = true;
        return send(id, `🚫 @${target} yasaklandı.`);
    }

    if (text.startsWith('/yasakkalk ')) {
        if (!isAdmin(id)) return send(id, '❌ Yetersiz yetki.');
        const target = text.split(' ')[1]?.replace('@','');
        const found  = Object.entries(users).find(([,u]) => u.username === target);
        if (!found) return send(id, '❌ Bulunamadı.');
        found[1].banned = false;
        return send(id, `✅ @${target} yasağı kalktı.`);
    }

    if (text.startsWith('/delkey ')) {
        if (!isMod(id)) return send(id, '❌ Yetersiz yetki.');
        const k = text.split(' ')[1];
        if (!keys[k]) return send(id, '❌ Key bulunamadı.');
        delete keys[k];
        return send(id, `🗑 Key silindi: <code>${k}</code>`);
    }

    if (text.startsWith('/maintenance ')) {
        if (!isAdmin(id)) return send(id, '❌ Yetersiz yetki.');
        const val = text.split(' ')[1];
        maintenance = val === 'on';
        return send(id, `🔧 Bakım modu: ${maintenance ? '🔴 Aktif' : '🟢 Kapalı'}`);
    }

    // Oturum adımları
    if (sess.step === 'await_password') {
        await deleteMsg(id, msg.message_id);
        if (sess.promptMsgId) await deleteMsg(id, sess.promptMsgId);

        if (text !== ADMIN_PW) {
            sessions[id] = {};
            return send(id, '❌ Yanlış şifre!');
        }
        users[id] = { username: uname, rank: String(id) === String(ADMIN_ID) ? 'OWNER' : 'USER', banned: false, registered: true };
        sessions[id] = {};
        return showPanel(id, uname);
    }

    if (sess.step === 'await_announce') {
        announcementMsg = text === 'temizle' ? '' : text;
        sessions[id] = {};
        return send(id, text === 'temizle' ? '✅ Duyuru temizlendi.' : `✅ Duyuru ayarlandı:\n${text}`);
    }
}

// ══════════════════════════════════════
// WEBHOOK
// ══════════════════════════════════════
app.post('/webhook', async (req, res) => {
    res.sendStatus(200);
    const update = req.body;
    try {
        if (update.message)        await handleMessage(update.message);
        if (update.callback_query) await handleCallback(update.callback_query);
    } catch (e) {
        console.error('[NEXUS]', e.message);
    }
});

// ══════════════════════════════════════
// ENDPOINTS
// ══════════════════════════════════════
app.get('/ping', (req, res) => {
    res.json({
        status: maintenance ? 'maintenance' : 'ok',
        msg: maintenance ? 'maintenance' : 'online',
        announcement: !!announcementMsg,
        announcementMsg,
    });
});

app.get('/check', (req, res) => {
    const keyStr = req.query.key;
    if (!keyStr || !keys[keyStr]) return res.json({ status: 'invalid' });
    const k = keys[keyStr];
    if (k.expire && Date.now() > k.expire) return res.json({ status: 'expired' });
    res.json({ status: 'ok', rank: k.rank, game: k.game, expire: k.expire });
});

app.get('/', (req, res) => res.send('NEXUS HUB — Online'));

app.listen(PORT, () => console.log(`[NEXUS] Port ${PORT} aktif`));
