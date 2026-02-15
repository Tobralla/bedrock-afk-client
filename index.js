const bedrock = require('bedrock-protocol');
const { Authflow } = require('prismarine-auth');
const express = require('express');
const path = require('path');
const fs = require('fs');
const https = require('https');

const app = express();
const port = 8000;

// --- CONFIGURATION ---
// REPLACE THIS WITH YOUR REAL API KEY FROM /api IN-GAME
const API_KEY = '19c1ecd1c0764028b8f61861cbd53f9b'; 

const authDir = path.join(__dirname, 'auth');
if (!fs.existsSync(authDir)) fs.mkdirSync(authDir);

app.use(express.static('public'));

// Store active bots here
const accountData = new Map();

// 1. Load saved accounts on startup
function loadExistingAccounts() {
    console.log("Loading saved accounts...");
    if (fs.existsSync(authDir)) {
        fs.readdirSync(authDir).forEach(email => {
            const fullPath = path.join(authDir, email);
            if (fs.lstatSync(fullPath).isDirectory()) {
                accountData.set(email, { 
                    status: 'Offline', 
                    username: email, 
                    shards: "0" 
                });
            }
        });
    }
}
loadExistingAccounts();

// 2. Fetch Shards from DonutSMP API
function getShards(username) {
    return new Promise((resolve) => {
        const name = username.startsWith('.') ? username : `.${username}`;
        const options = {
            hostname: 'api.donutsmp.net',
            path: `/v1/stats/${encodeURIComponent(name)}`,
            method: 'GET',
            headers: { 'Authorization': API_KEY } // No 'Bearer' prefix usually needed for Donut
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

// 3. Main Bot Logic
async function startBot(email) {
    const existing = accountData.get(email);
    if (existing?.status === 'Online') return;

    accountData.set(email, { ...existing, status: 'Connecting...' });

    const flow = new Authflow(email, path.join(authDir, email), {
        flow: 'msal',
        authTitle: 'MinecraftJava',
        onMsaCode: (data) => console.log(`\n[${email}] AUTH CODE: ${data.user_code}\n`)
    });

    try {
        const client = bedrock.createClient({
            host: 'donutsmp.net',
            port: 19132,
            authFlow: flow,
            profilesFolder: path.join(authDir, email),
            skipPing: true
        });

        client.on('spawn', async () => {
            const name = client.username.startsWith('.') ? client.username : `.${client.username}`;
            const shards = await getShards(name);
            
            accountData.set(email, { client, status: 'Online', username: name, shards });
            console.log(`[${email}] Connected as ${name}`);
        });

        client.on('error', (err) => {
            console.error(`[${email}] Error: ${err.message}`);
            accountData.set(email, { ...accountData.get(email), status: 'Offline', client: null });
        });

        client.on('close', () => {
            accountData.set(email, { ...accountData.get(email), status: 'Offline', client: null });
        });
    } catch (e) {
        accountData.set(email, { status: 'Error', username: email });
    }
}

// --- ROUTES ---

app.get('/add', (req, res) => { startBot(req.query.email); res.send("OK"); });
app.get('/connect', (req, res) => { startBot(req.query.email); res.send("OK"); });
app.get('/disconnect', (req, res) => {
    const bot = accountData.get(req.query.email);
    if (bot?.client) bot.client.disconnect();
    res.send("OK");
});

// THE WORKING CHAT FIX
app.get('/chat', (req, res) => {
    const { email, message } = req.query;
    const bot = accountData.get(email);

    if (bot && bot.client && bot.status === 'Online') {
        try {
            bot.client.queue('text', {
                type: 'raw', 
                needs_translation: false, 
                source_name: '',
                message: String(message), 
                xuid: '', 
                platform_chat_id: ''
            });
            res.send("Sent");
        } catch (err) {
            console.error(err);
            res.status(500).send("Error");
        }
    } else {
        res.status(400).send("Offline");
    }
});

app.get('/status', (req, res) => {
    // Convert Map to Array for the frontend
    const list = Array.from(accountData.entries()).map(([email, info]) => ({
        email, 
        status: info.status, 
        username: info.username, 
        shards: info.shards
    }));
    res.json(list);
});

// Update shards every 60 seconds
setInterval(async () => {
    for (let [email, data] of accountData.entries()) {
        if (data.status === 'Online') {
            const s = await getShards(data.username);
            accountData.set(email, { ...data, shards: s });
        }
    }
}, 60000);


app.listen(port, () => console.log(`Dashboard: http://localhost:${port}`));
