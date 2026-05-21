import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import 'dotenv/config';

import { initializeDatabase } from './src/config/database.js';
import db from './src/config/database.js';
import { getBot, initializeBot } from './src/bot/telegram.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

// Boot the LibSQL Database
initializeDatabase().catch(console.error);

// --- 1. SETUP EXPRESS SERVER (THE DASHBOARD) ---
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/logs', async (req, res) => {
    try {
        const result = await db.execute('SELECT * FROM transactions ORDER BY date DESC LIMIT 50');
        res.json({ success: true, data: result.rows });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// --- 2. SETUP TELEGRAM WEBHOOK ---
initializeBot();
const bot = getBot();

// Secret path so random scanners can't hit your bot
const WEBHOOK_PATH = `/telegraf/${process.env.TELEGRAM_BOT_TOKEN}`;
app.use(bot.webhookCallback(WEBHOOK_PATH));

// Set this to your Cloudflare Tunnel URL!
const DOMAIN = 'https://unsoiled-fifty-overcome.ngrok-free.dev';
bot.telegram.setWebhook(`${DOMAIN}${WEBHOOK_PATH}`);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`\n🏛️ Agent Dashboard running on http://localhost:${PORT}`);
    console.log(`[SYSTEM] 🔗 Webhook listening at ${DOMAIN}${WEBHOOK_PATH}`);
});