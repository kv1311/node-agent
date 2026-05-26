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
            done INTEGER DEFAULT 0,
            fired_at TEXT DEFAULT ''
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

        CREATE TABLE IF NOT EXISTS journal (
            id TEXT PRIMARY KEY,
            title TEXT,
            content TEXT NOT NULL,
            mood TEXT DEFAULT '',
            tags TEXT DEFAULT '',
            source_session TEXT DEFAULT '',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE INDEX IF NOT EXISTS idx_journal_created 
        ON journal(created_at);

        CREATE INDEX IF NOT EXISTS idx_conversations_session 
        ON conversations(session_id, created_at);

        CREATE TABLE IF NOT EXISTS obligations (
        id TEXT PRIMARY KEY,
        from_party TEXT NOT NULL,
        to_party TEXT NOT NULL,
        total_amount REAL NOT NULL,
        paid_total REAL DEFAULT 0,
        remaining REAL NOT NULL,
        currency TEXT DEFAULT 'INR',
        due_date TEXT,
        installments INTEGER DEFAULT 1,
        purpose TEXT,
        status TEXT DEFAULT 'active',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_payment_date TEXT,
        metadata TEXT DEFAULT '{}'
        );

        CREATE TABLE IF NOT EXISTS obligation_settlements (
        id TEXT PRIMARY KEY,
        obligation_id TEXT NOT NULL,
        amount_paid REAL NOT NULL,
        payment_date TEXT NOT NULL,
        from_account TEXT DEFAULT 'unknown',
        notes TEXT DEFAULT '',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(obligation_id) REFERENCES obligations(id)
        );

        CREATE INDEX IF NOT EXISTS idx_obligations_party 
        ON obligations(from_party, to_party, status);

        CREATE INDEX IF NOT EXISTS idx_obligations_status 
        ON obligations(status);

        CREATE INDEX IF NOT EXISTS idx_obligations_due
        ON obligations(due_date, status);

        CREATE INDEX IF NOT EXISTS idx_settlements_obligation
        ON obligation_settlements(obligation_id, payment_date);

        CREATE TABLE IF NOT EXISTS accounts (
        id TEXT PRIMARY KEY,
        name TEXT UNIQUE NOT NULL,
        type TEXT NOT NULL,
        balance REAL DEFAULT 0,
        currency TEXT DEFAULT 'INR',
        credit_limit REAL,
        outstanding REAL DEFAULT 0,
        is_liability INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        metadata TEXT DEFAULT '{}'
        );
        
        CREATE INDEX IF NOT EXISTS idx_accounts_type ON accounts(type);
        CREATE INDEX IF NOT EXISTS idx_accounts_liability ON accounts(is_liability);
        
        CREATE TABLE IF NOT EXISTS account_transactions (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        amount REAL NOT NULL,
        type TEXT NOT NULL,
        category TEXT,
        description TEXT,
        transaction_date TEXT NOT NULL,
        notes TEXT DEFAULT '',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(account_id) REFERENCES accounts(id)
        );
        
        CREATE INDEX IF NOT EXISTS idx_account_tx_account ON account_transactions(account_id, transaction_date);
        CREATE INDEX IF NOT EXISTS idx_account_tx_date ON account_transactions(transaction_date);
        CREATE INDEX IF NOT EXISTS idx_account_tx_category ON account_transactions(category);
        -- Full‑text search for conversations
        CREATE VIRTUAL TABLE IF NOT EXISTS conversations_fts USING fts5(content, session_id, tokenize='porter');

        -- Triggers to keep FTS in sync
        CREATE TRIGGER IF NOT EXISTS conversations_ai AFTER INSERT ON conversations BEGIN
        INSERT INTO conversations_fts(rowid, content, session_id) VALUES (new.rowid, new.content, new.session_id);
        END;

        CREATE TRIGGER IF NOT EXISTS conversations_ad AFTER DELETE ON conversations BEGIN
        INSERT INTO conversations_fts(conversations_fts, rowid, content, session_id) VALUES('delete', old.rowid, old.content, old.session_id);
        END;

        -- Backfill existing conversations
        INSERT OR IGNORE INTO conversations_fts(rowid, content, session_id)
        SELECT rowid, content, session_id FROM conversations WHERE rowid NOT IN (SELECT rowid FROM conversations_fts);
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