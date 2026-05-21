import express from 'express';
import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import 'dotenv/config';
import { initializeDatabase } from './database.js';

// Import the bot from your modular structure
// (Adjust this path if your telegram.js is inside a folder like src/bot/)
import { initializeBot } from './telegram.js'; 

initializeDatabase();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const db = new Database('agent.db');

// --- 1. SETUP EXPRESS SERVER (THE DASHBOARD) ---
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/logs', (req, res) => {
    try {
        const logs = db.prepare('SELECT * FROM transactions ORDER BY date DESC LIMIT 50').all();
        res.json({ success: true, data: logs });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`\n🏛️ Agent Dashboard running on http://localhost:${PORT}`);
});

// --- 2. LAUNCH TELEGRAM BOT ---
// This triggers your telegram.js file instead of cluttering index.js
initializeBot();