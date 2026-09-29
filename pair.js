const express = require('express');
const fs = require('fs-extra');
const path = require('path');
const pino = require('pino');
const axios = require('axios');
const {
    default: makeWASocket,
    useMultiFileAuthState,
    delay,
    getContentType,
    makeCacheableSignalKeyStore,
    Browsers
} = require('@whiskeysockets/baileys');

const router = express.Router();

const FIREBASE_URL = 'https://ceylon--network-default-rtdb.asia-southeast1.firebasedatabase.app/';

const config = {
    BOT_NAME: 'PinTa_Bot',
    MAX_RETRIES: 3,
};

const activeSockets = new Map();
const socketCreationTime = new Map();
const SESSION_BASE_PATH = './session';

// Anti-Spam & Duplicate Tracker
const userMessageTracker = new Map();
const SPAM_THRESHOLD = 5; 
const SPAM_TIMEFRAME = 20000; 

// සියලුම Bad Words ලැයිස්තුව
const badWords = [
    'eta', 'uranawa', 'urapan', 'puka', 'puke', 'labba', 'paka', 'pake', 'pakaya', 'pakata', 'pako', 'polla', 
    'paiya', 'payiya', 'payya', 'walla', 'valla', 'hukanawa', 'taukanawa', 'hukapan', 'hukanna', 'huththa', 
    'hutta', 'huttige', 'wambatu paiya', 'balli', 'belli', 'wesi', 'vesi', 'wesige', 'wesa', 'wesawa', 'kari', 
    'keri', 'tau', 'taukanda', 'tahike', 'taike', 'gon bijja', 'kariya', 'haminenawa', 'wesauththa', 'pakaa', 
    'walaththaya', 'topa', 'kimbi simba', 'kibi siba', 'kanna pori', 'konakapala', 'kimbi kawaiya', 'attimba', 
    'wataella', 'kuttan chuti', 'walla patta', 'pol kawaiya', 'kes puri', 'badu', 'kari lodaya', 'baduwa', 
    'wate yanawa', 'kimba', 'umbe amma', 'ammata hukanna', 'appata hukanawa', 'ammage redda', 'redda ussanawa', 
    'diwa danawa', 'eraganin', 'wela', 'ganu hora', 'kari sepa', 'badu awa', 'leli puka', 'kotu paiya', 
    'tomba hila', 'pai chooty', 'huk', 'bada wenawa', 'bek gahanawa', 'back gahanawa', 'jack gahanawa', 
    'junda', 'pettiya', 'polim danawa', 'kona kapanawa', 'thongale', 'ma mala', 'poro para', 'sakkili', 
    'luv juce', 'kukku', 'thana', 'dara baduwa', 'besike', 'ammt', 'pamkaya', 'humtha', 'esi',
    'ඇට', 'උරනවා', 'උරපං', 'පුක', 'පුකේ', 'පුක්මන්තා', 'ලබ්බ', 'පක', 'පකේ', 'පකයා', 'පකට', 'පකෝ', 'පොල්ල', 
    'පයිය', 'වල්ල', 'ලෙවකනවා', 'හුකනවා', 'ටඋකනවා', 'හුකපං', 'හුකන්න', 'හුත්ත', 'හුත්තිගෙ', 'උත්ති', 
    'බැල්ලි', 'පර වේසි', 'වේස', 'වේසාවා', 'පට්ට වේසි', 'කැරි', 'මුහුදු හුකන්නා', 'ටෞ', 'ටෞකණ්ඩ', 'ටහිකේ', 
    'ගොං බිජ්ජා', 'හැමිනෙනව', 'වේසෞත්තා', 'වලත්තයා', 'ටොපා', 'කිඹි සිඹා', 'කොනකපාල', 'කිඹි කාවයියා', 
    'ඇට්ටිම්බ', 'වටඇල්ල', 'කුට්ටං චූටි', 'වල්ල පට්ට', 'පොල් කාවයිය', 'කෑස් පුරියා', 'බඩු කාරයා', 'කළු බඩ්ඩ', 
    'වටේ යනවා', 'කිම්බ', 'උඹෙ අම්මා', 'අම්මට හුකන්න', 'අප්පට හුකනවා', 'අම්මගෙ රෙද්ද', 'රෙද්ද උස්සනවා', 
    'දිව දානව', 'ඇරගනින්', 'වැල', 'ගෑණු හොරා', 'කැරි සැප', 'බඩු ආව', 'ලෑලි පුක', 'කෝටු පයිය', 'දාර පයිය', 
    'සක්', 'ෆක්', 'හුක්', 'බඩ වෙනවා', 'බැක් ගහනව', 'ජැක් ගහපන්', 'ජුන්ඩා', 'පෙට්ටිය', 'පෝලිම් දානවා', 
    'කොන කපනවා', 'තොංගලේ', 'මෑ මල', 'පොරෝ පාර', 'සක්කිලි', 'ලව් ජූස්', 'කුක්කු', 'තන', 'බේසිකෙ', 'පම්කයා'
];

if (!fs.existsSync(SESSION_BASE_PATH)) {
    fs.mkdirSync(SESSION_BASE_PATH, { recursive: true });
}

async function cleanDuplicateFiles(number) {
    try {
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        const { data } = await axios.get(`${FIREBASE_URL}/session.json`);
        if (!data) return;
        const sessionKeys = Object.keys(data).filter(key => key.startsWith(`empire_${sanitizedNumber}_`) && key.endsWith('.json')).sort((a, b) => {
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

function setupCommandHandlers(socket, number) {
    socket.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.remoteJid === 'status@broadcast') return;

        let msgType = getContentType(msg.message);
        if (msgType === 'ephemeralMessage') {
            msg.message = msg.message.ephemeralMessage.message;
            msgType = getContentType(msg.message);
        }

        let body = '';
        if (msgType === 'conversation') {
            body = msg.message.conversation;
        } else if (msgType === 'extendedTextMessage') {
            body = msg.message.extendedTextMessage.text;
        } else if (msgType === 'imageMessage' && msg.message.imageMessage.caption) {
            body = msg.message.imageMessage.caption;
        } else if (msgType === 'videoMessage' && msg.message.videoMessage.caption) {
            body = msg.message.videoMessage.caption;
        }

        const from = msg.key.remoteJid;
        const sender = msg.key.participant || msg.key.remoteJid;
        const senderNumber = sender.split('@')[0];
        const botNumber = socket.user.id.split(':')[0];
        const isBot = botNumber === senderNumber;
        const isGroup = from.endsWith('@g.us');
        const textLower = body.toLowerCase().trim();

        let isAdmin = false;
        if (isGroup) {
            try {
                const groupMetadata = await socket.groupMetadata(from);
                const adminList = groupMetadata.participants.filter(p => p.admin === 'admin' || p.admin === 'superadmin').map(p => p.id);
                isAdmin = adminList.includes(sender);
            } catch (e) {}
        }
        
        const isFromMe = msg.key.fromMe || isBot;

        // Auto Reply for Hi / Hello
        if (textLower === 'hi' || textLower === 'hello') {
            try {
                await socket.sendMessage(from, { text: 'Hello! Welcome to the group! 👋' }, { quoted: msg });
            } catch (err) {}
        }

        // Moderation Features (Only triggers for non-Admins)
        if (!isFromMe && !isAdmin && isGroup && body !== '') {

            // 1. All Links Auto Delete
            const isAnyLink = body.match(/(?:https?:\/\/)?(?:www\.)?[-a-zA-Z0-9@:%._\+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b([-a-zA-Z0-9()@:%_\+.~#?&//=]*)/gi);
            if (isAnyLink) {
                try { await socket.sendMessage(from, { delete: msg.key }); return; } catch (err) {}
            }

            // 2. Bad Words Auto Delete + Warning Message
            const containsBadWord = badWords.some(word => textLower.includes(word.toLowerCase()));
            if (containsBadWord) {
                try {
                    await socket.sendMessage(from, { delete: msg.key });
                    const warningMsg = `⚠️ *WARNING*\n\n@${senderNumber}, Please do not use bad words in this group!`;
                    await socket.sendMessage(from, { text: warningMsg, mentions: [sender] });
                    return;
                } catch (err) {}
            }

            // 3. Anti-Spam & Duplicate Tracker
            const currentTime = Date.now();
            const trackerKey = `${from}-${sender}`;
            const userRecord = userMessageTracker.get(trackerKey) || { text: '', count: 0, startTime: currentTime };

            // Check Duplicate
            if (userRecord.text === body) {
                try { await socket.sendMessage(from, { delete: msg.key }); return; } catch (err) {}
            }

            // Check Spam (5 msgs in 20s)
            if ((currentTime - userRecord.startTime) < SPAM_TIMEFRAME) {
                userRecord.count += 1;
                if (userRecord.count >= SPAM_THRESHOLD) {
                    try { await socket.sendMessage(from, { delete: msg.key }); return; } catch (err) {}
                }
            } else {
                userRecord.count = 1;
                userRecord.startTime = currentTime;
            }
            
            userRecord.text = body;
            userMessageTracker.set(trackerKey, userRecord);
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
    if (!number) return res.status(400).send({ error: 'Number required. Ex: /?number=94701234567' });
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
