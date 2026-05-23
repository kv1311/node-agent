import express from 'express';
import { fileURLToPath } from 'url';
import path from 'path';
import 'dotenv/config';
import cors from 'cors';

import { startMorningBriefing } from './src/cron/morning.js';
import { initializeDatabase } from './src/config/database.js';
import { getBot, initializeBot } from './src/bot/telegram.js';

import taskRoutes     from './src/routes/tasks.routes.js';
import financeRoutes  from './src/routes/finance.routes.js';
import watchlistRoutes from './src/routes/watchlist.routes.js';
import chatRoutes     from './src/routes/chat.routes.js';
import memoryRoutes   from './src/routes/memory.routes.js';
import adminRoutes    from './src/routes/admin.routes.js';
import journalRoutes from './src/routes/journal.routes.js';

import { requestLogger, consoleLogger } from './src/middleware/logger.js';
import { apiLimiter, chatLimiter } from './src/middleware/rateLimiter.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(cors({
  origin: [
    'https://node-agent-ui.pages.dev',
    'http://localhost:3000',
  ],
  methods: ['GET', 'POST', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type', 'ngrok-skip-browser-warning'],
}));

app.use(express.json());


app.use(consoleLogger);
app.use(requestLogger);

app.use('/api', apiLimiter);
app.use('/api/chat', chatLimiter);

// Mount routes
app.use('/api', taskRoutes);
app.use('/api', financeRoutes);
app.use('/api', watchlistRoutes);
app.use('/api', chatRoutes);
app.use('/api', memoryRoutes);
app.use('/api', adminRoutes);
app.use('/api', journalRoutes);

if (process.env.ENVIRONMENT === 'production') {
  startMorningBriefing(bot);
  const WEBHOOK_PATH = `/telegraf/${process.env.TELEGRAM_BOT_TOKEN}`;
  app.use(bot.webhookCallback(WEBHOOK_PATH));
  bot.telegram.setWebhook(`${process.env.SERVER_DOMAIN}${WEBHOOK_PATH}`);
  console.log(`[SYSTEM] Webhook → ${process.env.SERVER_DOMAIN}${WEBHOOK_PATH}`);
} else {
  bot.launch();
  console.log(`[SYSTEM] Polling started.`);
}

const PORT = process.env.PORT || 3000;

async function start() {
  await initializeDatabase();
  
  app.listen(PORT, () => {
    console.log(`[SIA] Running on http://localhost:${PORT}`);
  });

  // Telegram
  initializeBot();
  const bot = getBot();

  if (process.env.ENVIRONMENT === 'production') {
    const WEBHOOK_PATH = `/telegraf/${process.env.TELEGRAM_BOT_TOKEN}`;
    app.use(bot.webhookCallback(WEBHOOK_PATH));
    await bot.telegram.setWebhook(`${process.env.SERVER_DOMAIN}${WEBHOOK_PATH}`);
    console.log(`[SYSTEM] Webhook → ${process.env.SERVER_DOMAIN}${WEBHOOK_PATH}`);
    startMorningBriefing(bot); // ← after everything is ready
  } else {
    bot.launch();
    console.log(`[SYSTEM] Polling started.`);
    startMorningBriefing(bot); // ← works in dev too for testing
  }
}

start();