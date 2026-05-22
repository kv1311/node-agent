import { createClient } from '@libsql/client';

const db = createClient({
    url: 'file:agent.db',
});

export async function initializeDatabase() {
    await db.executeMultiple(`
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

        CREATE TABLE IF NOT EXISTS Nodes (
            id TEXT PRIMARY KEY,
            label TEXT,
            type TEXT,
            metadata TEXT,
            canonical_key TEXT,
            is_active INTEGER DEFAULT 1,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS Edges (
            id TEXT PRIMARY KEY,
            source_id TEXT,
            target_id TEXT,
            relation TEXT,
            weight REAL DEFAULT 1.0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(source_id) REFERENCES Nodes(id),
            FOREIGN KEY(target_id) REFERENCES Nodes(id)
        );

        CREATE UNIQUE INDEX IF NOT EXISTS unique_edge
        ON Edges(source_id, target_id, relation);

        CREATE TABLE IF NOT EXISTS tasks (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            due_date TEXT DEFAULT '',
            done INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS reminders (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            remind_at TEXT DEFAULT '',
            done INTEGER DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS bills (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            amount REAL DEFAULT 0,
            due_date TEXT DEFAULT '',
            paid INTEGER DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS events (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            date TEXT DEFAULT '',
            notes TEXT DEFAULT ''
        );

        CREATE TABLE IF NOT EXISTS watchlist (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            type TEXT DEFAULT 'movie',
            genre TEXT DEFAULT '',
            watched INTEGER DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS conversations (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            role TEXT NOT NULL,
            content TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE INDEX IF NOT EXISTS idx_conversations_session 
        ON conversations(session_id, created_at);
    `);

    console.log("[SYSTEM] 🧠 SQLite (LibSQL) Memory Graph & Master Schema Initialized.");
}

export async function updateMonthlyRollup(dateStr, amount, type, owner) {
    const month = dateStr.substring(0, 7); 
    
    await db.execute({ sql: `INSERT OR IGNORE INTO monthly_rollups (month) VALUES (?)`, args: [month] });

    if (type === 'inflow') {
        await db.execute({ sql: `UPDATE monthly_rollups SET total_inflow = total_inflow + ?, last_updated = CURRENT_TIMESTAMP WHERE month = ?`, args: [amount, month] });
    } else if (type === 'outflow') {
        await db.execute({ sql: `UPDATE monthly_rollups SET total_outflow = total_outflow + ?, last_updated = CURRENT_TIMESTAMP WHERE month = ?`, args: [amount, month] });
        if (owner === 'uncle') {
            await db.execute({ sql: `UPDATE monthly_rollups SET uncle_investment_total = uncle_investment_total + ? WHERE month = ?`, args: [amount, month] });
        }
    }
}

export default db;