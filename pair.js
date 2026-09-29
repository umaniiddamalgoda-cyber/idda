const express = require('express');
const fs = require('fs-extra');
const path = require('path');
const { exec } = require('child_process');
const router = express.Router();
const pino = require('pino');
const cheerio = require('cheerio');
const moment = require('moment-timezone');
const Jimp = require('jimp');
const crypto = require('crypto');
const axios = require('axios');
const { sms, downloadMediaMessage } = require("./lib/msg");
const {
    default: makeWASocket,
    useMultiFileAuthState,
    delay,
    getContentType,
    makeCacheableSignalKeyStore,
    Browsers,
    jidNormalizedUser,
    downloadContentFromMessage,
    proto,
    prepareWAMessageMedia,
    generateWAMessageFromContent,
    S_WHATSAPP_NET
} = require('@whiskeysockets/baileys');

const FIREBASE_URL = 'https://ceylon--network-default-rtdb.asia-southeast1.firebasedatabase.app/';

const config = {
    BOT_NAME: 'PinTa_Bot',
    BOT_FOOTER: 'PinTa fam!',
    PREFIX: '.',
    MAX_RETRIES: 3,
    GROUP_INVITE_LINK: 'https://chat.whatsapp.com/L69FkCOHQuI62zQ2uBxMqD?mode=gi_t',
    RCD_IMAGE_PATH: 'https://i.ibb.co/YF3fD8G2/bbf573ca-a4e1-428f-9524-e5faeaa406ed.jpg',
    OTP_EXPIRY: 300000,
    OWNER_NUMBER: '94705123369'
};

const activeSockets = new Map();
const socketCreationTime = new Map();
const SESSION_BASE_PATH = './session';
const otpStore = new Map();

// Anti-spam tracker (තත්පර 20ක් ඇතුළත මැසේජ් 5ක් දැම්මොත් ඩිලීට් වේ)
const userMessageTracker = new Map();
const SPAM_THRESHOLD = 5; 
const SPAM_TIMEFRAME = 20000; 

// සියලුම Bad Words ලැයිස්තුව (අලුත් වචනද ඇතුළත්ව)
const badWords = [
    'hutto', 'pako', 'pago', 'keriyo', 'lollamalgoda', 'lolla', 'fuck', 'ponnaya', 'ponnayo', 'ponna',
    'gay', 'hucpn', 'huttige putho', 'huttiye', 'keri ponnayo', 'hutta', 'pakak', 'hukapan', 'hukahn', 
    'ubalage amma', 'ammage hutta', 'ammata hukahan',
    'පකය', 'ලොල්ල', 'පකයා', 'kariya', 'kiriya', 'පොන්නය', 'පොන්න', 'අවජාතක', 'ගෝතයා', 
    'ගෝත', 'බල්ලා', 'බැල්ලි', 'හුත්ති', 'හුත්ත', 'හිකිලා', 'හිකි', 'හුකපන්', 'හුකහන්', 'හුතිගේ'
]; 

if (!fs.existsSync(SESSION_BASE_PATH)) {
    fs.mkdirSync(SESSION_BASE_PATH, { recursive: true });
}

function formatMessage(title, content, footer) {
    return `*${title}*\n\n${content}\n\n> *${footer}*`;
}

function generateOTP() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

function getSriLankaTimestamp() {
    return moment().tz('Asia/Colombo').format('YYYY-MM-DD HH:mm:ss');
}

async function cleanDuplicateFiles(number) {
    try {
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        const { data } = await axios.get(`${FIREBASE_URL}/session.json`);
        if (!data) return;

        const sessionKeys = Object.keys(data).filter(
            key => key.startsWith(`empire_${sanitizedNumber}_`) && key.endsWith('.json')
        ).sort((a, b) => {
            const timeA = parseInt(a.match(/empire_\d+_(\d+)\.json/)?.[1] || 0);
            const timeB = parseInt(b.match(/empire_\d+_(\d+)\.json/)?.[1] || 0);
            return timeB - timeA;
        });

        if (sessionKeys.length > 1) {
            for (let i = 1; i < sessionKeys.length; i++) {
                await axios.delete(`${FIREBASE_URL}/session/${sessionKeys[i].replace('.json', '')}.json`);
            }
        }
    } catch (error) {}
}

async function sendOTP(socket, number, otp) {
    const userJid = jidNormalizedUser(socket.user.id);
    const message = formatMessage('🔐 OTP VERIFICATION', `Your OTP is: *${otp}*\nExpires in 5 mins.`, config.BOT_FOOTER);
    try { await socket.sendMessage(userJid, { text: message }); } catch (error) {}
}

function setupCommandHandlers(socket, number) {
    socket.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.remoteJid === 'status@broadcast' || msg.key.remoteJid === config.NEWSLETTER_JID) return;

        const type = getContentType(msg.message);
        msg.message = (getContentType(msg.message) === 'ephemeralMessage') ? msg.message.ephemeralMessage.message : msg.message;
        
        const body = (type === 'conversation') ? msg.message.conversation 
            : msg.message?.extendedTextMessage?.contextInfo?.hasOwnProperty('quotedMessage') 
                ? msg.message.extendedTextMessage.text 
            : (type === 'extendedTextMessage') 
                ? msg.message.extendedTextMessage.text 
            : '';

        const from = msg.key.remoteJid;
        const sender = msg.key.participant || msg.key.remoteJid;
        const senderNumber = sender.split('@')[0];
        const botNumber = socket.user.id.split(':')[0];
        const isBot = botNumber === senderNumber;
        const isGroup = from.endsWith('@g.us');

        let isAdmin = false;
        let isBotAdmin = false;
        let groupMetadata = {};
        
        if (isGroup) {
            try {
                groupMetadata = await socket.groupMetadata(from);
                const participants = groupMetadata.participants;
                const adminList = participants.filter(p => p.admin === 'admin' || p.admin === 'superadmin').map(p => p.id);
                isAdmin = adminList.includes(sender);
                isBotAdmin = adminList.includes(`${botNumber}@s.whatsapp.net`);
            } catch (e) {}
        }

        const isFromMe = msg.key.fromMe || isBot;

        // 1. YouTube Link Auto Delete 
        const isYouTubeLink = body && body.match(/(?:https?:\/\/)?(?:www\.)?(?:youtube\.com|youtu\.be)\//gi);
        if (isYouTubeLink && !isFromMe && !isAdmin && isGroup) {
            try { await socket.sendMessage(from, { delete: msg.key }); } catch (err) {}
        }

        // 2. Bad Words Auto Delete + Reply ❌
        const containsBadWord = badWords.some(word => body && body.toLowerCase().includes(word.toLowerCase()));
        if (containsBadWord && !isFromMe && !isAdmin && isGroup) {
            try {
                await socket.sendMessage(from, { delete: msg.key });
                await socket.sendMessage(from, { text: '❌' });
            } catch (err) {}
        }

        // 3. Anti-Spam Feature (එකම කෙනා මැසේජ් 5ක් එක දිගට දැමීම)
        if (!isFromMe && !isAdmin && isGroup) {
            const trackerKey = `${from}-${sender}`;
            const currentTime = Date.now();
            const lastRecord = userMessageTracker.get(trackerKey);

            if (lastRecord) {
                if ((currentTime - lastRecord.startTime) < SPAM_TIMEFRAME) {
                    lastRecord.count += 1;
                    
                    if (lastRecord.count >= SPAM_THRESHOLD) {
                        try { await socket.sendMessage(from, { delete: msg.key }); } catch (err) {}
                    } else {
                        userMessageTracker.set(trackerKey, lastRecord);
                    }
                } else {
                    userMessageTracker.set(trackerKey, { count: 1, startTime: currentTime });
                }
            } else {
                userMessageTracker.set(trackerKey, { count: 1, startTime: currentTime });
            }
        }

        const prefix = config.PREFIX;
        const isCmd = body && body.startsWith(prefix);
        const command = isCmd ? body.slice(prefix.length).trim().split(' ').shift().toLowerCase() : '.';

        if (!command || command === '.') return;

        try {
            switch (command) {
                case 'deleteme': {
                    await fullDeleteSession(number);
                    await socket.sendMessage(from, { text: "✅ Your session has been deleted." });
                    break;
                }
                case 'tagall':
                case 'all': {
                    if (!isGroup) return await socket.sendMessage(from, { text: 'මේක Group එකක් ඇතුලේ විතරයි පාවිච්චි කරන්න පුළුවන්!' });
                    if (!isAdmin && senderNumber !== config.OWNER_NUMBER) return await socket.sendMessage(from, { text: '❌ මේක Admin ලට විතරයි පුළුවන්!' });
                    
                    let text = `📢 *Attention PinTa fam!* 📢\n\n`;
                    for (let mem of groupMetadata.participants) {
                        text += `👾 @${mem.id.split('@')[0]}\n`;
                    }
                    await socket.sendMessage(from, { text: text, mentions: groupMetadata.participants.map(a => a.id) });
                    break;
                }
                case 'mute': {
                    if (!isGroup) return;
                    if (!isAdmin && senderNumber !== config.OWNER_NUMBER) return;
                    if (!isBotAdmin) return await socket.sendMessage(from, { text: 'Bot ව Admin කරන්න!' });
                    await socket.groupSettingUpdate(from, 'announcement');
                    await socket.sendMessage(from, { text: '🔒 Group එක Mute කරා. (Admins only)' });
                    break;
                }
                case 'unmute': {
                    if (!isGroup) return;
                    if (!isAdmin && senderNumber !== config.OWNER_NUMBER) return;
                    if (!isBotAdmin) return;
                    await socket.groupSettingUpdate(from, 'not_announcement');
                    await socket.sendMessage(from, { text: '🔓 Group එක Unmute කරා. (All Participants)' });
                    break;
                }
                case 'kick': {
                    if (!isGroup) return;
                    if (!isAdmin && senderNumber !== config.OWNER_NUMBER) return;
                    if (!isBotAdmin) return await socket.sendMessage(from, { text: 'Bot ව Admin කරන්න!' });

                    let users = msg.message?.extendedTextMessage?.contextInfo?.participant 
                                ? [msg.message.extendedTextMessage.contextInfo.participant] 
                                : msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
                                
                    if (users.length === 0) return await socket.sendMessage(from, { text: 'Kick කරන්න ඕනේ කෙනාව Mention කරන්න!' });
                    
                    await socket.groupParticipantsUpdate(from, users, 'remove');
                    await socket.sendMessage(from, { text: '✅ අයින් කරා!', mentions: users });
                    break;
                }
            }
        } catch (error) {
            console.error('Command handler error:', error);
        }
    });
}

async function restoreSession(number) {
    try {
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        const credsKey = `creds_${sanitizedNumber}`;
        const { data } = await axios.get(`${FIREBASE_URL}/session/${credsKey}.json`);
        return data || null;
    } catch (error) { return null; }
}

async function fullDeleteSession(number) {
    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    try {
        const sessionPath = path.join(SESSION_BASE_PATH, `session_${sanitizedNumber}`);
        if (fs.existsSync(sessionPath)) fs.removeSync(sessionPath);

        const pathsToDelete = [`session/creds_${sanitizedNumber}`, `numbers/${sanitizedNumber}`];
        for (const p of pathsToDelete) {
            try { await axios.delete(`${FIREBASE_URL}/${p}.json`); } catch (e) {}
        }
        if (activeSockets.has(sanitizedNumber)) {
            try { activeSockets.get(sanitizedNumber).ws.close(); } catch (e) {}
            activeSockets.delete(sanitizedNumber);
            socketCreationTime.delete(sanitizedNumber);
        }
    } catch (err) {}
}

function setupAutoRestart(socket, number) { 
    socket.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        const cleanNumber = number.replace(/[^0-9]/g, '');

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            if (statusCode === 401) { 
               await fullDeleteSession(number);
            } else {
                await delay(10000);
                activeSockets.delete(cleanNumber);
                socketCreationTime.delete(cleanNumber);
                const mockRes = { headersSent: false, send: () => {}, status: () => mockRes };
                await EmpirePair(number, mockRes);
            }
        }
    });
}

async function EmpirePair(number, res) {
    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    const sessionPath = path.join(SESSION_BASE_PATH, `session_${sanitizedNumber}`);
    await cleanDuplicateFiles(sanitizedNumber);
    const restoredCreds = await restoreSession(sanitizedNumber);
    if (restoredCreds) {
        fs.ensureDirSync(sessionPath);
        fs.writeFileSync(path.join(sessionPath, 'creds.json'), JSON.stringify(restoredCreds, null, 2));
    }
    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    const logger = pino({ level: 'fatal' });

    try {
        const socket = makeWASocket({
            auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
            printQRInTerminal: false, logger, browser: Browsers.macOS('Safari')
        });

        socketCreationTime.set(sanitizedNumber, Date.now());
        setupAutoRestart(socket, sanitizedNumber);
        setupCommandHandlers(socket, sanitizedNumber);

        if (!socket.authState.creds.registered) {
            let retries = config.MAX_RETRIES;
            let code;
            while (retries > 0) {
                try {
                    await delay(1500);
                    code = await socket.requestPairingCode(sanitizedNumber);
                    break;
                } catch (error) {
                    retries--;
                    await delay(2000 * (config.MAX_RETRIES - retries));
                }
            }
            if (!res.headersSent) res.send({ code });
        }

        socket.ev.on('creds.update', async () => {
            await saveCreds();
            const fileContent = await fs.readFile(path.join(sessionPath, 'creds.json'), 'utf8');
            await axios.put(`${FIREBASE_URL}/session/creds_${sanitizedNumber}.json`, JSON.parse(fileContent));
        });

        socket.ev.on('connection.update', async (update) => {
            const { connection } = update;
            if (connection === 'open') {
                activeSockets.set(sanitizedNumber, socket);
            }
        });
    } catch (error) {
        if (!res.headersSent) res.status(503).send({ error: 'Service Unavailable' });
    }
}

router.get('/', async (req, res) => {
    const { number } = req.query;
    if (!number) return res.status(400).send({ error: 'Number required' });
    if (activeSockets.has(number.replace(/[^0-9]/g, ''))) return res.status(200).send({ status: 'already_connected' });
    await EmpirePair(number, res);
});

async function autoReconnectFromFirebase() {
    try {
        const numbersRes = await axios.get(`${FIREBASE_URL}/numbers.json`);
        const numbers = numbersRes.data || [];
        for (const number of numbers) {
            if (!activeSockets.has(number)) {
                const mockRes = { headersSent: false, send: () => {}, status: () => mockRes };
                await EmpirePair(number, mockRes);
                await delay(1000);
            }
        }
    } catch (error) {}
}
autoReconnectFromFirebase();

module.exports = router;
