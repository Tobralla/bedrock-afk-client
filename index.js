const bedrock = require('bedrock-protocol');
const { Authflow } = require('prismarine-auth');
const express = require('express');
const path = require('path');
const fs = require('fs');
const https = require('https');
const { SocksClient } = require('socks');

const app = express();
const port = process.env.PORT || 8000;

const API_KEY = '19c1ecd1c0764028b8f61861cbd53f9b';
const authDir = path.join(__dirname, 'auth');
if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });

// --- OXYLABS PROXY CONFIGURATION ---
const PROXIES = [
    'socks5://inxxafk_73QY2:QaReEvB=e7=61l2@dc.oxylabs.io:8001',
    'socks5://inxxafk_73QY2:QaReEvB=e7=61l2@dc.oxylabs.io:8002',
    'socks5://inxxafk_73QY2:QaReEvB=e7=61l2@dc.oxylabs.io:8003',
    'socks5://inxxafk_73QY2:QaReEvB=e7=61l2@dc.oxylabs.io:8004',
    'socks5://inxxafk_73QY2:QaReEvB=e7=61l2@dc.oxylabs.io:8005'
];
const ACCOUNTS_PER_PROXY = 5;

const accountData = new Map();
let debugLogs = [];

function addLog(email, message) {
    const entry = `[${new Date().toLocaleTimeString()}] [${email}] ${message}`;
    debugLogs.push(entry);
    if (debugLogs.length > 50) debugLogs.shift();
    console.log(entry);
}

// --- PERSISTENT ACCOUNT LOADING ---
// This scans your auth folder to make sure bots show up on refresh
if (fs.existsSync(authDir)) {
    fs.readdirSync(authDir).forEach(email => {
        const fullPath = path.join(authDir, email);
        if (fs.lstatSync(fullPath).isDirectory()) {
            accountData.set(email, { 
                status: 'Offline', 
                username: email, 
                shards: "0",
                proxy: 'Pending...' 
            });
            addLog(email, "Loaded existing session from storage.");
        }
    });
}

function getShards(username) {
    return new Promise((resolve) => {
        const name = username.startsWith('.') ? username : `.${username}`;
        const options = {
            hostname: 'api.donutsmp.net',
            path: `/v1/stats/${encodeURIComponent(name)}`,
            method: 'GET',
            headers: { 'Authorization': API_KEY }
        };
        const req = https.get(options, (res) => {
            let body = '';
            res.on('data', d => body += d);
            res.on('end', () => {
                try {
                    const json = JSON.parse(body);
                    resolve(json.result?.shards || "0");
                } catch { resolve("0"); }
            });
        });
        req.on('error', () => resolve("0"));
        req.end();
    });
}

async function startBot(email) {
    const existing = accountData.get(email);
    if (existing?.status === 'Online' || existing?.status === 'Connecting...') return;

    // Assignment Logic
    const allEmails = Array.from(accountData.keys());
    const accountIndex = allEmails.indexOf(email);
    const proxyString = PROXIES[Math.floor(accountIndex / ACCOUNTS_PER_PROXY) % PROXIES.length];
    const proxyLabel = proxyString.split('@')[1]; 

    addLog(email, `Initializing via proxy: ${proxyLabel}`);
    accountData.set(email, { ...existing, status: 'Connecting...', proxy: proxyLabel });

    const flow = new Authflow(email, path.join(authDir, email), {
        flow: 'msal', 
        authTitle: 'MinecraftJava',
        onMsaCode: (data) => addLog(email, `AUTH REQUIRED: ${data.user_code}`)
    });

    try {
        const url = new URL(proxyString);
        const client = bedrock.createClient({
            host: 'donutsmp.net',
            port: 19132,
            authFlow: flow,
            profilesFolder: path.join(authDir, email),
            skipPing: true,
            connect: (address, port) => {
                return SocksClient.createConnection({
                    proxy: {
                        host: url.hostname,
                        port: parseInt(url.port),
                        type: 5,
                        userId: url.username,
                        password: url.password
                    },
                    command: 'connect',
                    destination: { host: address, port: port }
                }).then(info => info.socket);
            }
        });

        client.on('spawn', async () => {
            const name = client.username.startsWith('.') ? client.username : `.${client.username}`;
            const shards = await getShards(name);
            accountData.set(email, { client, status: 'Online', username: name, shards, proxy: proxyLabel });
            addLog(email, `SUCCESS: Spawned as ${name}`);
        });

        client.on('error', (err) => {
            addLog(email, `ERROR: ${err.message}`);
            accountData.set(email, { ...accountData.get(email), status: 'Offline', client: null });
        });

        client.on('close', () => {
            addLog(email, "Connection closed.");
            accountData.set(email, { ...accountData.get(email), status: 'Offline', client: null });
        });

    } catch (e) { 
        addLog(email, `CRITICAL ERROR: ${e.message}`);
        accountData.set(email, { status: 'Error', username: email, proxy: proxyLabel }); 
    }
}

// --- VERIFIED ROUTES ---

app.get('/add', (req, res) => {
    const email = req.query.email;
    if (!accountData.has(email)) {
        accountData.set(email, { status: 'Offline', username: email, shards: "0", proxy: 'Pending...' });
    }
    startBot(email);
    res.send("OK");
});

app.get('/connect', (req, res) => {
    startBot(req.query.email);
    res.send("OK");
});

app.get('/disconnect', (req, res) => {
    const bot = accountData.get(req.query.email);
    if (bot?.client) bot.client.disconnect();
    res.send("OK");
});

// YOUR VERIFIED CHAT LOGIC
app.get('/chat', (req, res) => {
    const { email, message } = req.query;
    const bot = accountData.get(email);
    if (bot?.client && bot.status === 'Online') {
        bot.client.queue('text', {
            type: 'raw', 
            needs_translation: false, 
            source_name: '',
            message: String(message), 
            xuid: '', 
            platform_chat_id: ''
        });
        res.send("OK");
    } else {
        res.status(400).send("Bot offline");
    }
});

app.get('/logs', (req, res) => res.json(debugLogs));

app.get('/status', (req, res) => {
    const list = Array.from(accountData.entries()).map(([email, info]) => ({
        email, 
        status: info.status, 
        username: info.username, 
        shards: info.shards,
        // Make sure this specific line is here:
        proxy: info.proxy || 'None' 
    }));
    res.json(list);
});

app.get('/update-shards', async (req, res) => {
    const bot = accountData.get(req.query.email);
    if (bot) {
        const s = await getShards(bot.username);
        accountData.set(req.query.email, { ...bot, shards: s });
        res.json({ shards: s });
    } else { res.status(404).send("Not Found"); }
});

app.use(express.static('public'));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.listen(port, () => console.log(`Dashboard active on port ${port}`));
