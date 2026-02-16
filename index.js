const bedrock = require('bedrock-protocol');
const { Authflow } = require('prismarine-auth');
const express = require('express');
const path = require('path');
const fs = require('fs');
const https = require('https');

const app = express();
const port = process.env.PORT || 3000;

// --- CONFIGURATION ---
const API_KEY = 'YOUR_API_KEY_HERE'; // Replace with your real key
const authDir = path.join(__dirname, 'auth');

if (!fs.existsSync(authDir)) fs.mkdirSync(authDir);
app.use(express.static('public'));

// Store active bots and their data
const accountData = new Map();
// Store reconnect timers so we can cancel them on manual disconnect
const reconnectTimers = new Map();

// --- 1. SETUP & UTILS ---

// Load saved accounts on startup
function loadExistingAccounts() {
    console.log("Loading saved accounts...");
    if (fs.existsSync(authDir)) {
        fs.readdirSync(authDir).forEach(email => {
            const fullPath = path.join(authDir, email);
            if (fs.lstatSync(fullPath).isDirectory()) {
                accountData.set(email, { 
                    status: 'Offline', 
                    username: email, 
                    shards: "0",
                    client: null 
                });
            }
        });
    }
}
loadExistingAccounts();

// Fetch Shards from DonutSMP API
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

// --- 2. BOT LOGIC ---

async function startBot(email) {
    const existing = accountData.get(email);
    
    // If already online, don't double-join
    if (existing?.status === 'Online') return;

    // Clear any pending reconnect timers (user forced a connect)
    if (reconnectTimers.has(email)) {
        clearTimeout(reconnectTimers.get(email));
        reconnectTimers.delete(email);
    }

    accountData.set(email, { ...existing, status: 'Connecting...', username: email });

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
            skipPing: true,
            connectTimeout: 20000
        });

        client.on('spawn', async () => {
            const name = client.username.startsWith('.') ? client.username : `.${client.username}`;
            const shards = await getShards(name);
            
            accountData.set(email, { 
                client, 
                status: 'Online', 
                username: name, 
                shards 
            });
            console.log(`[${email}] Connected as ${name}`);
        });

        client.on('error', (err) => {
            console.error(`[${email}] Error: ${err.message}`);
            handleDisconnect(email);
        });

        client.on('close', () => {
            console.log(`[${email}] Connection closed.`);
            handleDisconnect(email);
        });

    } catch (e) {
        console.error(`[${email}] Init Error:`, e);
        accountData.set(email, { status: 'Error', username: email });
        // Retry init after 30s if it was a login fail
        scheduleReconnect(email, 30000); 
    }
}

function handleDisconnect(email) {
    // 1. Mark as offline
    const bot = accountData.get(email);
    if (bot) {
        accountData.set(email, { ...bot, status: 'Offline', client: null });
    }

    // 2. Schedule Auto-Relog
    scheduleReconnect(email, 15000);
}

function scheduleReconnect(email, delayMs) {
    if (reconnectTimers.has(email)) return; // Already scheduled

    console.log(`[${email}] Auto-reconnecting in ${delayMs / 1000} seconds...`);
    
    const timer = setTimeout(() => {
        reconnectTimers.delete(email);
        console.log(`[${email}] Attempting Reconnect...`);
        startBot(email);
    }, delayMs);

    reconnectTimers.set(email, timer);
}

// --- 3. WEB ROUTES ---

app.get('/add', (req, res) => { 
    startBot(req.query.email); 
    res.send("Starting..."); 
});

app.get('/connect', (req, res) => { 
    startBot(req.query.email); 
    res.send("Connecting..."); 
});

app.get('/disconnect', (req, res) => {
    const email = req.query.email;
    const bot = accountData.get(email);

    // CRITICAL: Stop the auto-relog timer
    if (reconnectTimers.has(email)) {
        clearTimeout(reconnectTimers.get(email));
        reconnectTimers.delete(email);
        console.log(`[${email}] Auto-relog cancelled by user.`);
    }

    if (bot?.client) {
        bot.client.disconnect(); // This will trigger 'close', but we check the timer in handleDisconnect logic? 
        // Actually, 'close' event triggers handleDisconnect.
        // We need to make sure handleDisconnect doesn't restart it if we asked for it.
        // Solution: The listener fires, calls handleDisconnect, which schedules a timer.
        // We need to wait for the disconnect to finish, then clear the timer again.
        
        // Simpler approach: Remove the listener before disconnecting, OR set a flag.
        bot.client.removeAllListeners('close');
        bot.client.removeAllListeners('error');
        bot.client.disconnect();
    }
    
    accountData.set(email, { ...bot, status: 'Offline', client: null });
    res.send("Disconnected.");
});

// WORKING CHAT ROUTE
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

app.get('/update-shards', async (req, res) => {
    const email = req.query.email;
    const bot = accountData.get(email);
    if (bot && bot.username) {
        const s = await getShards(bot.username);
        accountData.set(email, { ...bot, shards: s });
        res.json({ shards: s });
    } else {
        res.json({ shards: "0" });
    }
});

app.get('/status', (req, res) => {
    const list = Array.from(accountData.entries()).map(([email, info]) => ({
        email, 
        status: info.status, 
        username: info.username, 
        shards: info.shards
    }));
    res.json(list);
});

// Global Shard Refresh Loop (Every 60s)
setInterval(async () => {
    for (let [email, data] of accountData.entries()) {
        if (data.status === 'Online' && data.username) {
            const s = await getShards(data.username);
            accountData.set(email, { ...data, shards: s });
        }
    }
}, 60000);

app.listen(port, () => console.log(`Server running on port ${port}`));
