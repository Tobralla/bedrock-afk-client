const bedrock = require('bedrock-protocol');
const { Authflow } = require('prismarine-auth');
const express = require('express');
const path = require('path');
const fs = require('fs');
const https = require('https');

const app = express();
// Priority 1: Use the port provided by the host (Koyeb/Railway)
// Priority 2: Use 8000 as a fallback
const port = process.env.PORT || 8000;

const API_KEY = '19c1ecd1c0764028b8f61861cbd53f9b'; 
const authDir = path.join(__dirname, 'auth');
if (!fs.existsSync(authDir)) fs.mkdirSync(authDir);

app.use(express.static('public'));

const accountData = new Map();

// Load existing account folders on startup
if (fs.existsSync(authDir)) {
    fs.readdirSync(authDir).forEach(email => {
        const fullPath = path.join(authDir, email);
        if (fs.lstatSync(fullPath).isDirectory()) {
            accountData.set(email, { status: 'Offline', username: email, shards: "0" });
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
    if (accountData.get(email)?.status === 'Online') return;
    accountData.set(email, { status: 'Connecting...', username: email, shards: "0" });

    const flow = new Authflow(email, path.join(authDir, email), {
        flow: 'msal',
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
            console.log(`[${email}] Success: ${name} is now AFK.`);
        });

        client.on('error', (err) => {
            console.error(`[${email}] Error: ${err.message}`);
            accountData.set(email, { status: 'Offline', username: email, shards: "0" });
        });

        client.on('close', () => {
            accountData.set(email, { status: 'Offline', username: email, shards: "0" });
        });
    } catch (e) {
        accountData.set(email, { status: 'Error', username: email });
    }
}

// --- API ROUTES ---

app.get('/add', (req, res) => { startBot(req.query.email); res.send("OK"); });
app.get('/connect', (req, res) => { startBot(req.query.email); res.send("OK"); });
app.get('/disconnect', (req, res) => {
    const bot = accountData.get(req.query.email);
    if (bot?.client) bot.client.disconnect();
    res.send("OK");
});

app.get('/update-shards', async (req, res) => {
    const bot = accountData.get(req.query.email);
    if (bot) {
        const s = await getShards(bot.username);
        accountData.set(req.query.email, { ...bot, shards: s });
        res.json({ shards: s });
    } else { res.status(404).send("Not Found"); }
});

app.get('/chat', (req, res) => {
    const { email, message } = req.query;
    const bot = accountData.get(email);
    if (bot?.client && bot.status === 'Online') {
        bot.client.queue('text', {
            type: 'chat', needs_translation: false, source_name: bot.client.username,
            message: String(message), xuid: '', platform_chat_id: '', filtered_message: ''
        });
        res.send("Sent");
    } else { res.status(400).send("Offline"); }
});

app.get('/status', (req, res) => {
    const list = Array.from(accountData.entries()).map(([email, info]) => ({
        email, status: info.status, username: info.username, shards: info.shards
    }));
    res.json(list);
});

app.listen(port, () => {
    console.log(`\n--- DonutSMP AFK Client ---\nDashboard active on port ${port}\n`);
});
