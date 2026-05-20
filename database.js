const Database = require('better-sqlite3');
const path = require('path');

// Initialize the SQLite database in the root directory
const db = new Database(path.join(__dirname, '..', '..', 'agent.db'));

// Enable WAL mode for better performance
db.pragma('journal_mode = WAL');

// Create tables if they do not exist
db.exec(`
  CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    amount REAL NOT NULL,
    type TEXT NOT NULL,
    category TEXT,
    description TEXT,
    date DATETIME DEFAULT CURRENT_TIMESTAMP,
    owner TEXT DEFAULT 'personal'
  );

  CREATE TABLE IF NOT EXISTS reminders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task TEXT NOT NULL,
    scheduled_time DATETIME NOT NULL,
    is_completed INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    topic TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS user_config (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_chat_id TEXT UNIQUE
  );
`);

/**
 * Add a new transaction.
 * @param {Object} transaction
 * @param {number} transaction.amount
 * @param {string} transaction.type - 'income', 'expense', 'investment'
 * @param {string} [transaction.category]
 * @param {string} [transaction.description]
 * @param {string} [transaction.date] - ISO string or YYYY-MM-DD HH:MM:SS (defaults to current time)
 * @param {string} [transaction.owner='personal'] - Use 'uncle' or similar to separate portfolios
 */
function addTransaction({ amount, type, category, description, date, owner = 'personal' }) {
  const stmt = db.prepare(`
    INSERT INTO transactions (amount, type, category, description, date, owner)
    VALUES (?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP), ?)
  `);
  return stmt.run(amount, type, category || null, description || null, date || null, owner);
}

/**
 * Add a new reminder.
 * @param {Object} reminder
 * @param {string} reminder.task
 * @param {string} reminder.scheduled_time - ISO string or YYYY-MM-DD HH:MM:SS
 * @param {boolean|number} [reminder.is_completed=0]
 */
function addReminder({ task, scheduled_time, is_completed = 0 }) {
  const stmt = db.prepare(`
    INSERT INTO reminders (task, scheduled_time, is_completed)
    VALUES (?, ?, ?)
  `);
  return stmt.run(task, scheduled_time, is_completed ? 1 : 0);
}

/**
 * Add a new memory node.
 * @param {Object} memory
 * @param {string} memory.topic
 * @param {string} memory.content
 */
function addMemory({ topic, content }) {
  const stmt = db.prepare(`
    INSERT INTO memories (topic, content)
    VALUES (?, ?)
  `);
  return stmt.run(topic, content);
}

/**
 * Set or update the Telegram Chat ID for push notifications.
 * @param {string} telegramChatId
 */
function setChatId(telegramChatId) {
  const stmt = db.prepare(`
    INSERT INTO user_config (id, telegram_chat_id)
    VALUES (1, ?)
    ON CONFLICT(id) DO UPDATE SET telegram_chat_id = excluded.telegram_chat_id
  `);
  return stmt.run(telegramChatId);
}

/**
 * Run custom read queries safely.
 * @param {string} sql - The SELECT query string
 * @param {Array} [params=[]] - Query parameters
 * @returns {Array} Array of row objects
 */
function query(sql, params = []) {
  const stmt = db.prepare(sql);
  return stmt.all(...params);
}

module.exports = {
  db,
  addTransaction,
  addReminder,
  addMemory,
  setChatId,
  query
};
