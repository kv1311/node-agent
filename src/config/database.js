import Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid'; // We use this for unique Node/Edge IDs

// Initialize the single database instance
const db = new Database('agent.db');
db.pragma('journal_mode = WAL');

export function initializeDatabase() {
    db.exec(`
        -- 1. THE DETERMINISTIC ENGINE
        CREATE TABLE IF NOT EXISTS transactions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            message_id TEXT UNIQUE,
            amount REAL,
            type TEXT,
            category TEXT,
            description TEXT,
            date DATETIME DEFAULT CURRENT_TIMESTAMP,
            owner TEXT DEFAULT 'personal',
            account_source TEXT DEFAULT 'unknown',
            synced_to_cloud INTEGER DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS monthly_rollups (
            month TEXT PRIMARY KEY, 
            total_inflow REAL DEFAULT 0,
            total_outflow REAL DEFAULT 0,
            uncle_investment_total REAL DEFAULT 0,
            last_updated DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        -- 2. THE OBSIDIAN MEMORY GRAPH
        CREATE TABLE IF NOT EXISTS Nodes (
            id TEXT PRIMARY KEY,
            label TEXT NOT NULL,
            type TEXT NOT NULL,
            metadata TEXT, -- Stored as a JSON blob
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS Edges (
            id TEXT PRIMARY KEY,
            source_id TEXT,
            target_id TEXT,
            relation TEXT NOT NULL,
            weight REAL DEFAULT 1.0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(source_id) REFERENCES Nodes(id),
            FOREIGN KEY(target_id) REFERENCES Nodes(id)
        );

        -- 3. SYSTEM CONFIG
        CREATE TABLE IF NOT EXISTS user_config (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            telegram_chat_id TEXT UNIQUE
        );
    `);
    console.log("[SYSTEM] 🧠 SQLite Memory Graph & Master Schema Initialized.");
}

// --- ROLLUP UTILITY (Called automatically when transactions are logged) ---
export function updateMonthlyRollup(dateStr, amount, type, owner) {
    // Extract YYYY-MM from standard timestamp
    const month = dateStr.substring(0, 7); 
    
    // Ensure the row exists for this month
    db.prepare(`INSERT OR IGNORE INTO monthly_rollups (month) VALUES (?)`).run(month);

    if (type === 'inflow') {
        db.prepare(`UPDATE monthly_rollups SET total_inflow = total_inflow + ?, last_updated = CURRENT_TIMESTAMP WHERE month = ?`).run(amount, month);
    } else if (type === 'outflow') {
        db.prepare(`UPDATE monthly_rollups SET total_outflow = total_outflow + ?, last_updated = CURRENT_TIMESTAMP WHERE month = ?`).run(amount, month);
        
        // Dynamically track the uncle pool
        if (owner === 'uncle') {
            db.prepare(`UPDATE monthly_rollups SET uncle_investment_total = uncle_investment_total + ? WHERE month = ?`).run(amount, month);
        }
    }
}

// Export the db instance so other files don't lock the database by calling "new Database()"
export default db;