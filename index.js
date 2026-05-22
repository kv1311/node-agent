import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import 'dotenv/config';

import { initializeDatabase } from './src/config/database.js';
import db from './src/config/database.js';
import { getBot, initializeBot } from './src/bot/telegram.js';

import { v4 as uuidv4 } from 'uuid';


const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
import cors from 'cors';
app.use(cors({
  origin: [
    'https://node-agent-ui.pages.dev',   // NO trailing slash
    'http://localhost:3000',
  ],
  methods: ['GET', 'POST', 'PATCH'],
  allowedHeaders: ['Content-Type', 'ngrok-skip-browser-warning'],
}));

app.use(express.json());

// ---- GET routes for frontend ----
app.get('/api/tasks', async (req, res) => {
  try {
    const result = await db.execute('SELECT * FROM tasks ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/reminders', async (req, res) => {
  try {
    const result = await db.execute('SELECT * FROM reminders ORDER BY remind_at DESC');
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/bills', async (req, res) => {
  try {
    const result = await db.execute('SELECT * FROM bills ORDER BY due_date DESC');
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/events', async (req, res) => {
  try {
    const result = await db.execute('SELECT * FROM events ORDER BY date DESC');
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/watchlist', async (req, res) => {
  try {
    const result = await db.execute('SELECT * FROM watchlist ORDER BY title ASC');
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ---- POST routes using db.execute (correct for LibSQL) ----
app.post('/api/tasks', async (req, res) => {
  const { title, due_date } = req.body;
  const id = uuidv4();
  try {
    await db.execute(
      'INSERT INTO tasks (id, title, due_date, done) VALUES (?, ?, ?, 0)',
      [id, title, due_date || '']
    );
    res.json({ id, title, due_date: due_date || '', done: false });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/reminders', async (req, res) => {
  const { title, remind_at } = req.body;
  const id = uuidv4();
  try {
    await db.execute(
      'INSERT INTO reminders (id, title, remind_at, done) VALUES (?, ?, ?, 0)',
      [id, title, remind_at || '']
    );
    res.json({ id, title, remind_at: remind_at || '', done: false });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/bills', async (req, res) => {
  const { title, amount, due_date } = req.body;
  const id = uuidv4();
  try {
    await db.execute(
      'INSERT INTO bills (id, title, amount, due_date, paid) VALUES (?, ?, ?, ?, 0)',
      [id, title, amount || 0, due_date || '']
    );
    res.json({ id, title, amount: amount || 0, due_date: due_date || '', paid: false });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/events', async (req, res) => {
  const { title, date, notes } = req.body;
  const id = uuidv4();
  try {
    await db.execute(
      'INSERT INTO events (id, title, date, notes) VALUES (?, ?, ?, ?)',
      [id, title, date || '', notes || '']
    );
    res.json({ id, title, date: date || '', notes: notes || '' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/watchlist', async (req, res) => {
  const { title, type, genre } = req.body;
  const id = uuidv4();
  try {
    await db.execute(
      'INSERT INTO watchlist (id, title, type, genre, watched) VALUES (?, ?, ?, ?, 0)',
      [id, title, type || 'movie', genre || '']
    );
    res.json({ id, title, type: type || 'movie', genre: genre || '', watched: false });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

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