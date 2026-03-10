const mineflayer = require('mineflayer');
const { Movements, pathfinder, goals } = require('mineflayer-pathfinder');
const { GoalBlock } = goals;
const fs = require('fs');
const express = require('express');
const http = require('http');
const https = require('https');

// Load Config
const config = JSON.parse(fs.readFileSync('config.json', 'utf8'));

// ============================================================
// EXPRESS SERVER - Keep Render/Aternos alive
// ============================================================
const app = express();
const PORT = process.env.PORT || 3000;

let botState = {
  connected: false,
  lastActivity: Date.now(),
  reconnectAttempts: 0,
  startTime: Date.now(),
  errors: [],
  wasThrottled: false
};

app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
      <head>
        <title>${config.name} Status</title>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
          body { font-family: sans-serif; background: #0f172a; color: #f8fafc; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; }
          .container { background: #1e293b; padding: 40px; border-radius: 20px; box-shadow: 0 0 50px rgba(45, 212, 191, 0.2); text-align: center; width: 400px; border: 1px solid #334155; }
          .stat-card { background: #0f172a; padding: 15px; margin: 15px 0; border-radius: 10px; border: 1px solid #1e3a5f; }
          .stat-value { font-size: 22px; font-weight: 700; color: #2dd4bf; }
          .live-indicator { display: inline-block; width: 10px; height: 10px; border-radius: 50%; background: #4ade80; animation: pulse 1.5s infinite; }
          @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
        </style>
      </head>
      <body>
        <div class="container">
          <h1><span class="live-indicator"></span> ${config.name}</h1>
          <div class="stat-card">
            <div style="color: #94a3b8;">Status</div>
            <div class="stat-value">${botState.connected ? 'ONLINE' : 'RECONNECTING'}</div>
          </div>
          <div class="stat-card">
            <div style="color: #94a3b8;">Server</div>
            <div style="color: #38bdf8;">${config.server.ip}</div>
          </div>
        </div>
      </body>
    </html>
  `);
});

app.get('/health', (req, res) => {
  res.json({
    status: botState.connected ? 'connected' : 'disconnected',
    uptime: Math.floor((Date.now() - botState.startTime) / 1000),
    coords: (bot && bot.entity) ? bot.entity.position : null,
  });
});

app.get('/ping', (req, res) => res.send('pong'));

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`[Server] Heartbeat dashboard started on port ${PORT}`);
});

// ============================================================
// SELF-PING - Prevent Render from sleeping
// ============================================================
function startSelfPing() {
  const renderUrl = process.env.RENDER_EXTERNAL_URL;
  if (!renderUrl) return;
  setInterval(() => {
    const protocol = renderUrl.startsWith('https') ? https : http;
    protocol.get(`${renderUrl}/ping`, (res) => {}).on('error', (err) => {});
  }, 10 * 60 * 1000);
}
startSelfPing();

// ============================================================
// BOT CREATION & LOGIC
// ============================================================
let bot = null;
let activeIntervals = [];
let isReconnecting = false;
let lastDiscordSend = 0;

function clearAllIntervals() {
  activeIntervals.forEach(id => clearInterval(id));
  activeIntervals = [];
}

function createBot() {
  if (isReconnecting) return;
  if (bot) {
    clearAllIntervals();
    bot.removeAllListeners();
    try { bot.end(); } catch (e) {}
  }

  console.log(`[Bot] Connecting to ${config.server.ip}:${config.server.port}...`);

  bot = mineflayer.createBot({
    username: config['bot-account'].username === "." ? "AFK_Bot" : config['bot-account'].username,
    auth: config['bot-account'].type,
    host: config.server.ip,
    port: config.server.port,
    version: config.server.version
  });

  bot.loadPlugin(pathfinder);

  bot.once('spawn', () => {
    botState.connected = true;
    botState.reconnectAttempts = 0;
    isReconnecting = false;
    console.log(`[Bot] Successfully joined the server!`);
    
    sendDiscordWebhook(`✅ **Bot Connected** to ${config.server.ip}`, 0x4ade80);

    const mcData = require('minecraft-data')(bot.version);
    const defaultMove = new Movements(bot, mcData);
    initializeModules(bot, mcData, defaultMove);
  });

  bot.on('end', (reason) => {
    console.log(`[Bot] Disconnected: ${reason}`);
    botState.connected = false;
    clearAllIntervals();
    if (!isReconnecting) {
        isReconnecting = true;
        setTimeout(() => {
            isReconnecting = false;
            createBot();
        }, 15000);
    }
  });

  bot.on('error', (err) => console.log(`[Bot] Error: ${err.message}`));
}

function initializeModules(bot, mcData, defaultMove) {
  // Auto Auth
  if (config.utils['auto-auth']?.enabled) {
    setTimeout(() => {
      bot.chat(`/register ${config.utils['auto-auth'].password} ${config.utils['auto-auth'].password}`);
      bot.chat(`/login ${config.utils['auto-auth'].password}`);
    }, 3000);
  }

  // Anti-AFK (Random Jumps & Movements)
  if (config.utils['anti-afk']?.enabled) {
    const id = setInterval(() => {
      if (bot.entity) {
        bot.setControlState('jump', true);
        setTimeout(() => bot.setControlState('jump', false), 500);
      }
    }, 20000);
    activeIntervals.push(id);
    
    if (config.utils['anti-afk'].sneak) bot.setControlState('sneak', true);
  }

  // Chat Responses
  bot.on('chat', (username, message) => {
    if (username === bot.username) return;
    if (config.chat?.respond && message.toLowerCase().includes('hello')) {
        bot.chat(`Hello ${username}! I am an AFK bot.`);
    }
  });
}

// ============================================================
// DISCORD WEBHOOK (Completed Function)
// ============================================================
function sendDiscordWebhook(content, color = 0x0099ff) {
  if (!config.discord?.enabled || !config.discord.webhookUrl || config.discord.webhookUrl.includes('YOUR_DISCORD')) return;

  const now = Date.now();
  if (now - lastDiscordSend < 5000) return; 
  lastDiscordSend = now;

  const data = JSON.stringify({
    embeds: [{
      title: config.name,
      description: content,
      color: color,
      timestamp: new Date()
    }]
  });

  const options = {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(data),
    },
  };

  const req = https.request(config.discord.webhookUrl, options);
  req.on('error', (e) => console.error(`[Discord] Webhook error: ${e.message}`));
  req.write(data);
  req.end();
}

createBot();
