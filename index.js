import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import 'dotenv/config';

import { initializeDatabase } from './src/config/database.js';
import db from './src/config/database.js';
import { getBot, initializeBot } from './src/bot/telegram.js';



const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

const cors = require('cors')
app.use(cors({
  origin: [
    'https://node-agent-ui.pages.dev/',  // your Cloudflare Pages URL
    'http://localhost:3000',            // local dev
  ],
  methods: ['GET', 'POST', 'PATCH'],
  allowedHeaders: ['Content-Type'],
}))

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

const { v4: uuidv4 } = require('uuid')
// npm install uuid  ← run this if not installed

// POST /api/tasks
app.post('/api/tasks', (req, res) => {
  const { title, due_date } = req.body
  const id = uuidv4()
  db.run(
    'INSERT INTO tasks (id, title, due_date, done) VALUES (?, ?, ?, 0)',
    [id, title, due_date || ''],
    function(err) {
      if (err) return res.status(500).json({ error: err.message })
      res.json({ id, title, due_date: due_date || '', done: false })
    }
  )
})

// POST /api/reminders
app.post('/api/reminders', (req, res) => {
  const { title, remind_at } = req.body
  const id = uuidv4()
  db.run(
    'INSERT INTO reminders (id, title, remind_at, done) VALUES (?, ?, ?, 0)',
    [id, title, remind_at || ''],
    function(err) {
      if (err) return res.status(500).json({ error: err.message })
      res.json({ id, title, remind_at: remind_at || '', done: false })
    }
  )
})

// POST /api/bills
app.post('/api/bills', (req, res) => {
  const { title, amount, due_date } = req.body
  const id = uuidv4()
  db.run(
    'INSERT INTO bills (id, title, amount, due_date, paid) VALUES (?, ?, ?, ?, 0)',
    [id, title, amount || 0, due_date || ''],
    function(err) {
      if (err) return res.status(500).json({ error: err.message })
      res.json({ id, title, amount: amount || 0, due_date: due_date || '', paid: false })
    }
  )
})

// POST /api/events
app.post('/api/events', (req, res) => {
  const { title, date, notes } = req.body
  const id = uuidv4()
  db.run(
    'INSERT INTO events (id, title, date, notes) VALUES (?, ?, ?, ?)',
    [id, title, date || '', notes || ''],
    function(err) {
      if (err) return res.status(500).json({ error: err.message })
      res.json({ id, title, date: date || '', notes: notes || '' })
    }
  )
})

// POST /api/watchlist
app.post('/api/watchlist', (req, res) => {
  const { title, type, genre } = req.body
  const id = uuidv4()
  db.run(
    'INSERT INTO watchlist (id, title, type, genre, watched) VALUES (?, ?, ?, ?, 0)',
    [id, title, type || 'movie', genre || ''],
    function(err) {
      if (err) return res.status(500).json({ error: err.message })
      res.json({ id, title, type: type || 'movie', genre: genre || '', watched: false })
    }
  )
})


// --- 2. SETUP TELEGRAM BOT & ENVIRONMENT ---
initializeBot();
const bot = getBot();

if (process.env.ENVIRONMENT === 'production') {
    // 🌍 SERVER MODE: Use Webhook
    const WEBHOOK_PATH = `/telegraf/${process.env.TELEGRAM_BOT_TOKEN}`;
    app.use(bot.webhookCallback(WEBHOOK_PATH));
    
    const DOMAIN = 'https://unsoiled-fifty-overcome.ngrok-free.dev'; 
    bot.telegram.setWebhook(`${DOMAIN}${WEBHOOK_PATH}`);
    console.log(`[SYSTEM] 🔗 Webhook mapped to ${DOMAIN}${WEBHOOK_PATH}`);
} else {
    // 💻 LOCAL MODE: Use Long-Polling
    bot.launch();
    console.log(`[SYSTEM] 💻 Local polling started. Webhook ignored.`);
}

// --- 3. START THE SERVER ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`\n🏛️ Agent Dashboard running on http://localhost:${PORT}`);
});