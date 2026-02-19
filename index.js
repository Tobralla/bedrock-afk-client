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

    const allEmails = Array.from(accountData.keys());
    const accountIndex = allEmails.indexOf(email);
    const proxyString = PROXIES[Math.floor(accountIndex / ACCOUNTS_PER_PROXY) % PROXIES.length];
    const proxyLabel = proxyString.split('@')[1]; 

    addLog(email, `Initializing via proxy: ${proxyLabel}`);
    
    // Set initial connecting state
    accountData.set(email, { ...existing, status: 'Connecting...', proxy: proxyLabel, authCode: null, authUrl: null });

    const flow = new Authflow(email, path.join(authDir, email), {
        flow: 'msal', 
        authTitle: 'MinecraftJava',
        onMsaCode: (data) => {
            // NEW: Update account data to show Auth UI on frontend
            accountData.set(email, { 
                ...accountData.get(email), 
                status: 'Authenticating',
                authCode: data.user_code,
                authUrl: data.verification_uri
            });
            addLog(email, `AUTH REQUIRED: Go to ${data.verification_uri} and enter code: ${data.user_code}`);
        }
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
            // Clear auth data on success
            accountData.set(email, { client, status: 'Online', username: name, shards, proxy: proxyLabel, authCode: null, authUrl: null });
            addLog(email, `SUCCESS: Spawned as ${name}`);
        });

        client.on('error', (err) => {
            addLog(email, `ERROR: ${err.message}`);
            const current = accountData.get(email);
            if(current) accountData.set(email, { ...current, status: 'Offline', client: null, authCode: null, authUrl: null });
        });

        client.on('close', () => {
            addLog(email, "Connection closed.");
            const current = accountData.get(email);
            if(current) accountData.set(email, { ...current, status: 'Offline', client: null, authCode: null, authUrl: null });
        });

    } catch (e) { 
        addLog(email, `CRITICAL ERROR: ${e.message}`);
        accountData.set(email, { status: 'Error', username: email, proxy: proxyLabel, authCode: null, authUrl: null }); 
    }
}

// --- ROUTES ---

app.get('/add', (req, res) => {
    const email = req.query.email;
    if (!accountData.has(email)) {
        accountData.set(email, { status: 'Offline', username: email, shards: "0", proxy: 'Pending...', authCode: null, authUrl: null });
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

app.get('/remove', (req, res) => {
    const email = req.query.email;
    if (!email) return res.status(400).send("Email required");
    const bot = accountData.get(email);
    if (bot?.client) { try { bot.client.disconnect(); } catch (e) {} }
    accountData.delete(email);
    const userAuthPath = path.join(authDir, email);
    if (fs.existsSync(userAuthPath)) {
        try {
            fs.rmSync(userAuthPath, { recursive: true, force: true });
            addLog(email, "Account data deleted.");
        } catch (err) { addLog(email, `Error deleting: ${err.message}`); }
    }
    res.send("OK");
});

app.get('/chat', (req, res) => {
    const { email, message } = req.query;
    const bot = accountData.get(email);
    if (bot?.client && bot.status === 'Online') {
        bot.client.queue('text', {
            type: 'raw', needs_translation: false, source_name: '',
            message: String(message), xuid: '', platform_chat_id: ''
        });
        res.send("OK");
    } else { res.status(400).send("Bot offline"); }
});

app.get('/logs', (req, res) => res.json(debugLogs));

// UPDATED: Return auth info for frontend UI
app.get('/status', (req, res) => {
    const list = Array.from(accountData.entries()).map(([email, info]) => ({
        email, 
        status: info.status, 
        username: info.username, 
        shards: info.shards,
        proxy: info.proxy || 'None',
        authCode: info.authCode,
        authUrl: info.authUrl
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

app.get('/update-all-shards', async (req, res) => {
    addLog("SYSTEM", "Bulk shard update...");
    const promises = [];
    accountData.forEach((bot, email) => {
        if(bot.username && bot.username !== email) {
            promises.push(getShards(bot.username).then(s => accountData.set(email, { ...bot, shards: s })));
        }
    });
    await Promise.all(promises);
    addLog("SYSTEM", "Update complete.");
    res.send("OK");
});

app.use(express.static('public'));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.listen(port, () => console.log(`Dashboard active on port ${port}`));
