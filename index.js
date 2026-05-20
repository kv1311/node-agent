const database = require('./src/config/database');
const { initBot } = require('./src/bot/telegram');

// Initialize the Telegram Bot
initBot();

console.log('AI Agent database layer and bot initialized successfully.');
