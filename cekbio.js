// [WAJIB DI BARIS PERTAMA] Fix bug dari node-telegram-bot-api untuk file buffer
process.env.NTBA_FIX_350 = 1;

import 'dotenv/config';
import {
    default as makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    Browsers,
    fetchLatestBaileysVersion
} from 'baileys';
import pino from 'pino';
import TelegramBot from 'node-telegram-bot-api';
import fs from 'fs';

// ════════════════════════════════════════════════
//  CONFIG & ENV
// ════════════════════════════════════════════════
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID;

if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.error("❌ FATAL: TELEGRAM_BOT_TOKEN atau TELEGRAM_CHAT_ID tidak ditemukan di .env!");
    process.exit(1);
}

const teleBot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });
const delay   = ms => new Promise(r => setTimeout(r, ms));

// ════════════════════════════════════════════════
//  STATE
// ════════════════════════════════════════════════
const botState = {
    isConnecting:    false,
    waitingForInput: false,
    jobQueue:        new Map(),
    config: {
        batch:    parseInt(process.env.DEFAULT_BATCH_SIZE) || 50,
        delay:    parseInt(process.env.DEFAULT_DELAY_MS)   || 2000,
        fetchDP:  true,
        fetchBio: true,
        fetchBiz: true,
    }
};

let sock;

// ════════════════════════════════════════════════
//  TIER CLASSIFICATION ENGINE
// ════════════════════════════════════════════════
function classifyNumber(res) {
    if (!res.isReg) return { tier: 'MATI', icon: '🪦', label: 'Tidak Terdaftar', group: 'dead' };

    if (res.isBiz) {
        const hasDP   = res.dp          && res.dp          !== '-';
        const hasBio  = res.bio         && res.bio         !== '-';
        const hasCat  = res.category    && res.category    !== '-';
        const hasDesc = res.description && res.description !== '-';

        if (hasDP && hasBio && hasCat)        return { tier: 'EXCLUSIVE', icon: '🏆', label: 'Bisnis · Exclusive',  group: 'biz_exclusive' };
        if ((hasDP || hasBio) && (hasCat || hasDesc)) return { tier: 'STANDARD', icon: '💎', label: 'Bisnis · Standard',   group: 'biz_standard'  };
        return                                        { tier: 'LOW META', icon: '📋', label: 'Bisnis · Low Meta',   group: 'biz_lowmeta'  };
    } else {
        const hasDP  = res.dp  && res.dp  !== '-';
        const hasBio = res.bio && res.bio !== '-';

        if (hasDP && hasBio && res.bio.length > 20) return { tier: 'PREMIUM', icon: '👑', label: 'Personal · Premium', group: 'per_premium' };
        if (hasDP || hasBio)                         return { tier: 'AKTIF',   icon: '✅', label: 'Personal · Aktif',   group: 'per_aktif'   };
        return                                               { tier: 'KOSONG',  icon: '🔘', label: 'Personal · Kosong',  group: 'per_kosong'  };
    }
}

// ════════════════════════════════════════════════
//  WHATSAPP CORE
// ════════════════════════════════════════════════
async function startWA(phoneNumberForPairing = null, chatId = null, messageId = null) {
    if (botState.isConnecting) return;
    botState.isConnecting = true;

    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    const { version, isLatest } = await fetchLatestBaileysVersion();
    console.log(`WA v${version.join('.')}, isLatest: ${isLatest}`);

    sock = makeWASocket({
        version,
        printQRInTerminal:         false,
        browser:                   Browsers.macOS('Chrome'),
        auth:                      state,
        logger:                    pino({ level: 'silent' }),
        markOnlineOnConnect:       false,
        generateHighQualityLinkPreview: false,
    });

    sock.ev.on('creds.update', saveCreds);

    if (phoneNumberForPairing && !sock.authState.creds.registered) {
        await editOrSend(chatId, messageId, UI.connecting(phoneNumberForPairing));

        setTimeout(async () => {
            try {
                const code = await sock.requestPairingCode(phoneNumberForPairing);
                const fmt  = code?.match(/.{1,4}/g)?.join('‑') || code;
                await editOrSend(chatId, messageId, UI.pairingCode(fmt));
            } catch (err) {
                botState.isConnecting = false;
                await editOrSend(chatId, messageId, UI.error(`Gagal request kode pairing.\n${err.message}`), backBtn());
            }
        }, 4000);
    }

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === 'close') {
            botState.isConnecting = false;
            const code = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = code !== DisconnectReason.loggedOut;

            if (shouldReconnect) {
                console.log(`[!] Reconnect dalam 5 detik (status: ${code})`);
                setTimeout(() => startWA(), 5000);
            } else {
                if (fs.existsSync('./auth_info_baileys'))
                    fs.rmSync('./auth_info_baileys', { recursive: true, force: true });
                sock = null;
                await teleBot.sendMessage(TELEGRAM_CHAT_ID, UI.kicked(), { parse_mode: 'Markdown' });
                sendDashboard(TELEGRAM_CHAT_ID);
            }
        } else if (connection === 'open') {
            botState.isConnecting = false;
            console.log('✅ WA Ready!');
            if (chatId) await sendDashboard(chatId, messageId);
            else await teleBot.sendMessage(TELEGRAM_CHAT_ID, UI.reconnected(), { parse_mode: 'Markdown' });
        }
    });
}

// ════════════════════════════════════════════════
//  TELEGRAM HELPERS
// ════════════════════════════════════════════════
async function editOrSend(chatId, msgId, text, markup = null) {
    const opts = { parse_mode: 'Markdown' };
    if (markup) opts.reply_markup = markup;
    try {
        if (msgId) await teleBot.editMessageText(text, { chat_id: chatId, message_id: msgId, ...opts });
        else        await teleBot.sendMessage(chatId, text, opts);
    } catch (_) {}
}

function backBtn() {
    return { inline_keyboard: [[{ text: '‹  Kembali ke Dashboard', callback_data: 'nav_dashboard' }]] };
}

function toggleKb() {
    const dp  = botState.config.fetchDP;
    const bio = botState.config.fetchBio;
    const biz = botState.config.fetchBiz;
    return {
        inline_keyboard: [
            [{ text: `${dp  ? '🟢' : '🔴'}  Foto Profil (DP)`, callback_data: 'toggle_dp'  }],
            [{ text: `${bio ? '🟢' : '🔴'}  Bio & Status`,      callback_data: 'toggle_bio' }],
            [{ text: `${biz ? '🟢' : '🔴'}  Profil Bisnis`,     callback_data: 'toggle_biz' }],
            [{ text: '‹  Kembali',                               callback_data: 'nav_dashboard' }],
        ]
    };
}

async function sendDashboard(chatId, msgId = null) {
    const isReg = fs.existsSync('./auth_info_baileys/creds.json');
    await editOrSend(chatId, msgId, UI.dashboard(isReg), UI.dashboardKb(isReg));
}

// ════════════════════════════════════════════════
//  UI TEMPLATES  ← semua teks bot ada di sini
// ════════════════════════════════════════════════
const UI = {

    // ── Divider utils ──────────────────────────
    line: (char = '─', len = 30) => char.repeat(len),

    // ── DASHBOARD ──────────────────────────────
    dashboard(isReg) {
        const dot    = isReg ? '🟢' : '🔴';
        const status = isReg ? 'Terhubung' : 'Tidak Terhubung';
        const c      = botState.config;
        const dpS    = c.fetchDP  ? '🟢' : '🔴';
        const bioS   = c.fetchBio ? '🟢' : '🔴';
        const bizS   = c.fetchBiz ? '🟢' : '🔴';

        return (
`🔍 *WA SUPER CHECKER PRO*
${this.line('━', 28)}

${dot} *WhatsApp*  ·  ${status}

⚙️ *Konfigurasi Aktif*
\`\`\`
  Batch   : ${String(c.batch).padEnd(4)} nomor / sesi
  Delay   : ${(c.delay/1000).toFixed(1).padEnd(4)} detik
  DP      : ${c.fetchDP  ? 'ON ' : 'OFF'}
  Bio     : ${c.fetchBio ? 'ON ' : 'OFF'}
  Bisnis  : ${c.fetchBiz ? 'ON ' : 'OFF'}
\`\`\`
${this.line('─', 28)}
🏷️ *Tier Klasifikasi*

🏆 *Exclusive*   ·  💎 *Standard*   ·  📋 *Low Meta*
👑 *Premium*     ·  ✅ *Aktif*      ·  🔘 *Kosong*
🪦 *Mati*
${this.line('─', 28)}
📂 Kirim file \`.txt\` berisi daftar nomor
_\\(satu nomor per baris, sertakan kode negara\\)_`
        );
    },

    dashboardKb(isReg) {
        return isReg ? {
            inline_keyboard: [
                [{ text: '⚙️  Batch & Delay',  callback_data: 'menu_settings' },
                 { text: '🔧  Toggle Fitur',   callback_data: 'menu_toggle'   }],
                [{ text: '🔄  Cek Status',     callback_data: 'action_check'  },
                 { text: '🚪  Logout',         callback_data: 'action_logout' }],
            ]
        } : {
            inline_keyboard: [
                [{ text: '🔑  Login & Pairing WhatsApp', callback_data: 'action_login' }]
            ]
        };
    },

    // ── PAIRING FLOW ───────────────────────────
    connecting(phone) {
        return (
`⏳ *Menghubungkan ke Server Meta...*
${this.line('─', 28)}
📱 Nomor   :  \`+${phone}\`
🔄 Status  :  Meminta kode pairing...

_Harap tunggu beberapa detik_`
        );
    },

    pairingCode(code) {
        return (
`✅ *Kode Pairing Berhasil Dibuat*
${this.line('─', 28)}
🔑 *Kode Anda:*

\`   ${code}   \`

${this.line('─', 28)}
*Langkah selanjutnya:*

1️⃣  Buka *WhatsApp* di ponsel Anda
2️⃣  Buka menu *Linked Devices*
3️⃣  Pilih *Link with phone number instead*
4️⃣  Masukkan kode di atas

_Sistem akan otomatis terhubung setelah kode dimasukkan._`
        );
    },

    kicked() {
        return (
`⚠️ *Sesi WhatsApp Dikeluarkan!*
${this.line('─', 28)}
Perangkat ini telah di\\-logout dari WhatsApp\\.
Sesi lama telah dihapus otomatis\\.

Silakan login kembali melalui Dashboard\\.`
        );
    },

    reconnected() {
        return (
`✅ *WhatsApp Terhubung Kembali*
${this.line('─', 28)}
Koneksi berhasil dipulihkan secara otomatis\\.`
        );
    },

    // ── INPUT NOMOR ────────────────────────────
    inputPhone() {
        return (
`📱 *Login · Input Nomor WhatsApp*
${this.line('─', 28)}
Kirimkan nomor HP beserta *kode negara*
langsung ke obrolan ini.

*Contoh format:*
\`\`\`
  Indonesia  :  6281234567890
  USA        :  12015550123
  Malaysia   :  60112345678
  UK         :  447911123456
\`\`\`
${this.line('─', 28)}
⚠️ _Jangan gunakan tanda + atau spasi_`
        );
    },

    // ── ERROR ──────────────────────────────────
    error(msg) {
        return (
`❌ *Terjadi Kesalahan*
${this.line('─', 28)}
${msg}`
        );
    },

    // ── INVALID PHONE ──────────────────────────
    invalidPhone() {
        return (
`❌ *Format Nomor Tidak Valid*
${this.line('─', 28)}
Nomor harus menyertakan kode negara
dan berisi 8–16 digit angka.

_Contoh: \`6281234567890\`_`
        );
    },

    // ── FILE SCAN RESULT ───────────────────────
    fileScan(count, estMin, estSec, filename) {
        const c = botState.config;
        return (
`📂 *File Berhasil Dipindai*
${this.line('─', 28)}
📄 File         :  ${filename}
✅ Nomor Valid  :  *${count}* nomor
${this.line('─', 28)}
⚙️ *Konfigurasi Saat Ini*
\`\`\`
  Batch  : ${c.batch} nomor / sesi
  Delay  : ${(c.delay/1000).toFixed(1)} detik
  DP     : ${c.fetchDP  ? 'ON' : 'OFF'}
  Bio    : ${c.fetchBio ? 'ON' : 'OFF'}
  Bisnis : ${c.fetchBiz ? 'ON' : 'OFF'}
\`\`\`
⏱️ Est. Selesai :  *${estMin > 0 ? estMin + ' mnt ' : ''}${estSec} detik*
${this.line('─', 28)}
Pilih aksi di bawah untuk melanjutkan:`
        );
    },

    // ── MENU SETTINGS ──────────────────────────
    menuSettings() {
        const c = botState.config;
        return (
`⚙️ *Pengaturan Batch & Delay*
${this.line('─', 28)}
*Batch saat ini :* ${c.batch} nomor/sesi
*Delay saat ini :* ${(c.delay/1000).toFixed(1)} detik
${this.line('─', 28)}
Pilih preset kecepatan:

🐢 *10  · Sangat Aman*    — delay 5 detik
🚶 *25  · Normal*         — delay 3 detik
🏃 *50  · Cepat* ⭐       — delay 2 detik
💨 *100 · Extreme*        — delay 1.5 detik

_Batch besar = lebih cepat, risiko rate‑limit lebih tinggi_`
        );
    },

    // ── MENU TOGGLE ────────────────────────────
    menuToggle() {
        return (
`🔧 *Toggle Fitur Pengambilan Data*
${this.line('─', 28)}
Aktifkan atau matikan fitur sesuai kebutuhan.
Menonaktifkan fitur mempercepat proses.
${this.line('─', 28)}`
        );
    },

    // ── PROGRESS ───────────────────────────────
    progress(processed, total, elapsed, errCount, buckets) {
        const pct    = Math.round((processed / total) * 100);
        const barLen = 20;
        const filled = Math.round((pct / 100) * barLen);
        const bar    = '█'.repeat(filled) + '░'.repeat(barLen - filled);

        const bizTotal = buckets.biz_exclusive.length + buckets.biz_standard.length + buckets.biz_lowmeta.length;
        const perTotal = buckets.per_premium.length   + buckets.per_aktif.length    + buckets.per_kosong.length;
        const dead     = buckets.dead.length;

        return (
`⚡️ *Pengecekan Sedang Berjalan...*
${this.line('─', 28)}
\`${bar}\`
📊 *${processed} / ${total}*  nomor  ·  *${pct}%*  selesai
⏱️ Elapsed  :  ${elapsed}s
⚠️ Error    :  ${errCount}
${this.line('─', 28)}
🏢 *Bisnis*  ·  ${bizTotal} total
  🏆 ${String(buckets.biz_exclusive.length).padStart(4)}   💎 ${String(buckets.biz_standard.length).padStart(4)}   📋 ${String(buckets.biz_lowmeta.length).padStart(4)}

👤 *Personal*  ·  ${perTotal} total
  👑 ${String(buckets.per_premium.length).padStart(4)}   ✅ ${String(buckets.per_aktif.length).padStart(4)}   🔘 ${String(buckets.per_kosong.length).padStart(4)}

🪦 *Mati*  ·  ${dead}
${this.line('─', 28)}
_Jeda antar sesi: ${botState.config.delay / 1000}s..._`
        );
    },

    // ── LAPORAN AKHIR ──────────────────────────
    finalReport(total, elapsed, errCount, buckets) {
        const bizTotal = buckets.biz_exclusive.length + buckets.biz_standard.length + buckets.biz_lowmeta.length;
        const perTotal = buckets.per_premium.length   + buckets.per_aktif.length    + buckets.per_kosong.length;
        const dead     = buckets.dead.length;

        return (
`🎉 *Pengecekan Selesai!*
${this.line('━', 28)}
📊 *Ringkasan Hasil*
\`\`\`
  Total Diproses  : ${String(total).padStart(6)}
  Berhasil        : ${String(total - errCount).padStart(6)}
  Error           : ${String(errCount).padStart(6)}
  Durasi          : ${elapsed}s
\`\`\`
${this.line('─', 28)}
🏢 *WA Bisnis*  ·  ${bizTotal} nomor
\`\`\`
  🏆 Exclusive  : ${String(buckets.biz_exclusive.length).padStart(5)}
  💎 Standard   : ${String(buckets.biz_standard.length).padStart(5)}
  📋 Low Meta   : ${String(buckets.biz_lowmeta.length).padStart(5)}
\`\`\`
${this.line('─', 28)}
👤 *WA Personal*  ·  ${perTotal} nomor
\`\`\`
  👑 Premium    : ${String(buckets.per_premium.length).padStart(5)}
  ✅ Aktif      : ${String(buckets.per_aktif.length).padStart(5)}
  🔘 Kosong     : ${String(buckets.per_kosong.length).padStart(5)}
\`\`\`
${this.line('─', 28)}
🪦 *Tidak Terdaftar*  ·  ${dead} nomor
${this.line('━', 28)}
📂 Mengirim ${[bizTotal > 0, perTotal > 0, dead > 0].filter(Boolean).length > 1 ? 'file‑file' : 'file'} hasil...`
        );
    },

    // ── START JOB ──────────────────────────────
    jobStarting(total, config) {
        return (
`⚡️ *Mesin Pengecekan Diaktifkan*
${this.line('─', 28)}
📊 Total Nomor  :  *${total}*
⚙️ Batch        :  *${config.batch}* nomor/sesi
⏱️ Delay        :  *${(config.delay/1000).toFixed(1)}* detik
${this.line('─', 28)}
_Memulai pemindaian pertama..._`
        );
    },
};

// ════════════════════════════════════════════════
//  BOOT
// ════════════════════════════════════════════════
console.log('⚡️ WA Super Checker Pro — Booting...');
if (fs.existsSync('./auth_info_baileys/creds.json')) {
    console.log('Sesi ditemukan. Auto-connect...');
    startWA();
} else {
    sendDashboard(TELEGRAM_CHAT_ID);
}

// ════════════════════════════════════════════════
//  TELEGRAM EVENTS
// ════════════════════════════════════════════════
teleBot.onText(/\/(start|menu|dashboard)/, (msg) => {
    if (msg.chat.id.toString() !== TELEGRAM_CHAT_ID) return;
    sendDashboard(msg.chat.id);
});

teleBot.on('message', async (msg) => {
    if (msg.chat.id.toString() !== TELEGRAM_CHAT_ID || !msg.text || msg.text.startsWith('/')) return;

    if (botState.waitingForInput) {
        const phone = msg.text.replace(/\D/g, '');
        botState.waitingForInput = false;

        if (!/^\d{8,16}$/.test(phone)) {
            return teleBot.sendMessage(msg.chat.id, UI.invalidPhone(), {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '🔄  Coba Lagi', callback_data: 'action_login'   }],
                        [{ text: '‹  Batal',      callback_data: 'nav_dashboard'  }],
                    ]
                }
            });
        }

        const wm = await teleBot.sendMessage(msg.chat.id,
            `⏳ _Memproses login untuk_ \`+${phone}\`\\.\\.\\.`,
            { parse_mode: 'Markdown' }
        );
        startWA(phone, msg.chat.id, wm.message_id);
    }
});

teleBot.on('document', async (msg) => {
    if (msg.chat.id.toString() !== TELEGRAM_CHAT_ID) return;

    if (!sock?.authState?.creds?.registered)
        return teleBot.sendMessage(msg.chat.id,
            UI.error('WhatsApp belum terhubung\\. Login dulu via /dashboard\\.'),
            { parse_mode: 'Markdown' }
        );

    if (!msg.document.file_name.endsWith('.txt'))
        return teleBot.sendMessage(msg.chat.id,
            UI.error('Hanya file berekstensi `.txt` yang diterima.'),
            { parse_mode: 'Markdown' }
        );

    try {
        const link   = await teleBot.getFileLink(msg.document.file_id);
        const raw    = await (await fetch(link)).text();
        const unique = [...new Set(
            raw.split('\n')
               .map(n => n.replace(/\D/g, ''))
               .filter(n => n.length >= 8 && n.length <= 16)
        )];

        if (unique.length === 0)
            return teleBot.sendMessage(msg.chat.id,
                UI.error('Tidak ada nomor valid ditemukan\\.\nPastikan format benar \\(sertakan kode negara\\)\\.'),
                { parse_mode: 'Markdown' }
            );

        const jobId   = Date.now().toString();
        botState.jobQueue.set(jobId, unique);

        const estTime = Math.ceil((unique.length / botState.config.batch) * (botState.config.delay / 1000));
        const estMin  = Math.floor(estTime / 60);
        const estSec  = estTime % 60;

        teleBot.sendMessage(msg.chat.id,
            UI.fileScan(unique.length, estMin, estSec, msg.document.file_name),
            {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '🚀  Mulai Pengecekan', callback_data: `start_${jobId}` }],
                        [{ text: '⚙️  Ubah Config',      callback_data: 'menu_settings'  },
                         { text: '‹  Batal',             callback_data: 'nav_dashboard'  }],
                    ]
                }
            }
        );
    } catch (err) {
        teleBot.sendMessage(msg.chat.id, UI.error(`Gagal memproses file: ${err.message}`), { parse_mode: 'Markdown' });
    }
});

teleBot.on('callback_query', async (query) => {
    const { message, data, id } = query;
    const chatId = message.chat.id;
    const msgId  = message.message_id;

    switch (true) {

        case data === 'nav_dashboard':
            botState.waitingForInput = false;
            await sendDashboard(chatId, msgId);
            break;

        case data === 'action_login':
            if (fs.existsSync('./auth_info_baileys/creds.json'))
                return teleBot.answerCallbackQuery(id, { text: '✅ WhatsApp sudah terhubung!', show_alert: true });
            botState.waitingForInput = true;
            await editOrSend(chatId, msgId, UI.inputPhone(), backBtn());
            break;

        case data === 'action_check': {
            const s = sock?.authState?.creds?.registered ? '🟢 Aktif & Terhubung' : '🔴 Tidak Terhubung';
            teleBot.answerCallbackQuery(id, { text: s, show_alert: true });
            break;
        }

        case data === 'action_logout':
            if (fs.existsSync('./auth_info_baileys'))
                fs.rmSync('./auth_info_baileys', { recursive: true, force: true });
            sock = null;
            teleBot.answerCallbackQuery(id, { text: '🚪 Sesi berhasil dihapus.', show_alert: true });
            await sendDashboard(chatId, msgId);
            break;

        case data === 'menu_settings':
            await editOrSend(chatId, msgId, UI.menuSettings(), {
                inline_keyboard: [
                    [{ text: '🐢  10 · Sangat Aman', callback_data: 'set_10'  },
                     { text: '🚶  25 · Normal',      callback_data: 'set_25'  }],
                    [{ text: '🏃  50 · Cepat ⭐',    callback_data: 'set_50'  },
                     { text: '💨  100 · Extreme',    callback_data: 'set_100' }],
                    [{ text: '‹  Kembali',            callback_data: 'nav_dashboard' }],
                ]
            });
            break;

        case data === 'menu_toggle':
            await editOrSend(chatId, msgId, UI.menuToggle(), toggleKb());
            break;

        case data === 'toggle_dp':
            botState.config.fetchDP = !botState.config.fetchDP;
            teleBot.answerCallbackQuery(id, { text: `Foto Profil: ${botState.config.fetchDP ? 'ON' : 'OFF'}` });
            await editOrSend(chatId, msgId, UI.menuToggle(), toggleKb());
            break;

        case data === 'toggle_bio':
            botState.config.fetchBio = !botState.config.fetchBio;
            teleBot.answerCallbackQuery(id, { text: `Bio & Status: ${botState.config.fetchBio ? 'ON' : 'OFF'}` });
            await editOrSend(chatId, msgId, UI.menuToggle(), toggleKb());
            break;

        case data === 'toggle_biz':
            botState.config.fetchBiz = !botState.config.fetchBiz;
            teleBot.answerCallbackQuery(id, { text: `Profil Bisnis: ${botState.config.fetchBiz ? 'ON' : 'OFF'}` });
            await editOrSend(chatId, msgId, UI.menuToggle(), toggleKb());
            break;

        case data.startsWith('set_'): {
            const nb = parseInt(data.split('_')[1]);
            botState.config.batch = nb;
            botState.config.delay = nb === 10 ? 5000 : nb === 25 ? 3000 : nb === 50 ? 2000 : 1500;

            const alertTxt  = nb >= 50
                ? `⚠️ Batch ${nb} aktif!\nRisiko rate-limit lebih tinggi. Gunakan dengan bijak.`
                : `✅ Batch ${nb} · Delay ${(botState.config.delay/1000).toFixed(1)}s`;
            await teleBot.answerCallbackQuery(id, { text: alertTxt, show_alert: nb >= 50 });
            await sendDashboard(chatId, msgId);
            break;
        }

        case data.startsWith('start_'): {
            const jobId = data.replace('start_', '');
            const list  = botState.jobQueue.get(jobId);
            if (!list)
                return teleBot.answerCallbackQuery(id, { text: '❌ Sesi kadaluarsa. Upload ulang file.', show_alert: true });

            botState.jobQueue.delete(jobId);
            await editOrSend(chatId, msgId, UI.jobStarting(list.length, botState.config));
            processBulkCheck(list, botState.config, chatId, msgId);
            break;
        }
    }

    teleBot.answerCallbackQuery(id).catch(() => {});
});

// ════════════════════════════════════════════════
//  CORE: BULK CHECK ENGINE
// ════════════════════════════════════════════════
async function processBulkCheck(numbers, config, chatId, msgId) {
    const buckets = {
        biz_exclusive: [], biz_standard: [], biz_lowmeta: [],
        per_premium:   [], per_aktif:    [], per_kosong:  [],
        dead:          [],
    };

    const total     = numbers.length;
    let   processed = 0;
    let   errCount  = 0;
    const startTime = Date.now();

    for (let i = 0; i < total; i += config.batch) {
        const batchNums = numbers.slice(i, i + config.batch);

        const batchPromises = batchNums.map(async (num, idx) => {
            await delay(idx * 150);

            const jid = `${num}@s.whatsapp.net`;
            const res = {
                num, isReg: false, isBiz: false,
                bio: '-', dp: '-', category: '-',
                description: '-', email: '-', website: '-',
                address: '-', fbPage: '-',
            };

            try {
                const [waResult] = await sock.onWhatsApp(jid);
                res.isReg = waResult?.exists || false;

                if (res.isReg) {
                    if (config.fetchBio) {
                        try { res.bio = (await sock.fetchStatus(jid))?.status || '-'; } catch (_) {}
                    }
                    if (config.fetchDP) {
                        try { res.dp = await sock.profilePictureUrl(jid, 'image') || '-'; } catch (_) {}
                    }
                    if (config.fetchBiz) {
                        try {
                            const biz = await sock.getBusinessProfile(jid);
                            if (biz && Object.keys(biz).length > 0) {
                                res.isBiz       = true;
                                res.category    = biz.category          || '-';
                                res.description = biz.description       || '-';
                                res.email       = biz.email             || '-';
                                res.website     = biz.website?.[0]?.url || '-';
                                res.address     = biz.address           || '-';
                                res.fbPage      = biz.fb_page           || '-';
                            }
                        } catch (_) {}
                    }
                }
            } catch (_) { errCount++; }

            return res;
        });

        const settled = await Promise.allSettled(batchPromises);
        settled.forEach(({ status, value: res }) => {
            if (status !== 'fulfilled') return;
            buckets[classifyNumber(res).group].push(res);
        });

        processed += batchNums.length;
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);

        await editOrSend(chatId, msgId,
            UI.progress(processed, total, elapsed, errCount, buckets)
        ).catch(() => {});

        if (processed < total) await delay(config.delay);
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    await editOrSend(chatId, msgId, UI.finalReport(total, elapsed, errCount, buckets), backBtn());

    // Kirim file hasil per tier
    const fOpts = { contentType: 'text/plain' };
    const ts    = Date.now();

    const fmtBiz = r =>
        `Nomor       : +${r.num}\n` +
        `Kategori    : ${r.category}\n` +
        `Deskripsi   : ${r.description}\n` +
        `Email       : ${r.email}\n` +
        `Website     : ${r.website}\n` +
        `Alamat      : ${r.address}\n` +
        `FB Page     : ${r.fbPage}\n` +
        `Bio/Status  : ${r.bio}\n` +
        `Foto Profil : ${r.dp}\n` +
        '─'.repeat(42) + '\n';

    const fmtPer = r =>
        `Nomor       : +${r.num}\n` +
        `Bio/Status  : ${r.bio}\n` +
        `Foto Profil : ${r.dp}\n` +
        '─'.repeat(42) + '\n';

    const fmtDead = r => `+${r.num}\n`;

    const files = [
        { key: 'biz_exclusive', label: 'WA_Bisnis_EXCLUSIVE', fmt: fmtBiz  },
        { key: 'biz_standard',  label: 'WA_Bisnis_STANDARD',  fmt: fmtBiz  },
        { key: 'biz_lowmeta',   label: 'WA_Bisnis_LOWMETA',   fmt: fmtBiz  },
        { key: 'per_premium',   label: 'WA_Personal_PREMIUM', fmt: fmtPer  },
        { key: 'per_aktif',     label: 'WA_Personal_AKTIF',   fmt: fmtPer  },
        { key: 'per_kosong',    label: 'WA_Personal_KOSONG',  fmt: fmtPer  },
        { key: 'dead',          label: 'WA_MATI',             fmt: fmtDead },
    ];

    for (const { key, label, fmt } of files) {
        const rows = buckets[key];
        if (rows.length === 0) continue;
        const header = buildFileHeader(label, rows.length, config);
        const buf    = Buffer.from(header + rows.map(fmt).join(''), 'utf-8');
        await teleBot.sendDocument(chatId, buf, {}, { ...fOpts, filename: `${label}_${ts}.txt` });
        await delay(600);
    }
}

// ════════════════════════════════════════════════
//  HELPER: FILE HEADER
// ════════════════════════════════════════════════
function buildFileHeader(label, count, config) {
    const now = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
    const line = '═'.repeat(48);
    return (
        line + '\n' +
        `  ★ WA SUPER CHECKER PRO  —  ${label}\n` +
        line + '\n' +
        `  Tanggal    : ${now} WIB\n` +
        `  Total      : ${count} nomor\n` +
        `  Batch      : ${config.batch} nomor  |  Delay: ${(config.delay/1000).toFixed(1)}s\n` +
        line + '\n\n'
    );
}
