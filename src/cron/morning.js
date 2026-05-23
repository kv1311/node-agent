import cron from 'node-cron';
import db from '../config/database.js';

import { log } from '../utils/log.js';

export function startMorningBriefing(bot) {
  // Every day at 8:00 AM IST (UTC+5:30 = 02:30 UTC)
  cron.schedule('30 2 * * *', async () => {
    try {
      const today = new Date().toISOString().split('T')[0];

      const [tasks, bills, reminders, events] = await Promise.all([
        db.execute(`SELECT title, due_date FROM tasks WHERE done = 0 ORDER BY created_at DESC LIMIT 5`),
        db.execute(`SELECT title, amount, due_date FROM bills WHERE paid = 0 ORDER BY due_date ASC LIMIT 5`),
        db.execute({
          sql: `SELECT title, remind_at FROM reminders WHERE done = 0 AND remind_at >= ? ORDER BY remind_at ASC LIMIT 5`,
          args: [today]
        }),
        db.execute({
          sql: `SELECT title, date FROM events WHERE date >= ? ORDER BY date ASC LIMIT 3`,
          args: [today]
        })
      ]);

      const lines = [];

      if (tasks.rows.length) {
        lines.push(`${tasks.rows.length} task${tasks.rows.length > 1 ? 's' : ''} pending.`);
        tasks.rows.forEach(t => {
          const due = t.due_date ? ` · ${t.due_date}` : '';
          lines.push(`  — ${t.title}${due}`);
        });
      }

      if (bills.rows.length) {
        lines.push(`\n${bills.rows.length} unpaid bill${bills.rows.length > 1 ? 's' : ''}.`);
        bills.rows.forEach(b => {
          const due = b.due_date ? ` · due ${b.due_date}` : '';
          lines.push(`  — ${b.title} ₹${b.amount}${due}`);
        });
      }

      if (reminders.rows.length) {
        lines.push(`\nReminders today.`);
        reminders.rows.forEach(r => {
          lines.push(`  — ${r.title}`);
        });
      }

      if (events.rows.length) {
        lines.push(`\nComing up.`);
        events.rows.forEach(e => {
          lines.push(`  — ${e.title} · ${e.date}`);
        });
      }

      if (lines.length === 0) {
        lines.push('Clear day ahead.');
      }

      const message = lines.join('\n');
      const chatId = process.env.TELEGRAM_CHAT_ID;

      if (!chatId) {
        log.cron('TELEGRAM_CHAT_ID not set in .env — briefing skipped');
        return;
      }

      await bot.telegram.sendMessage(chatId, message);
      log.cron('Morning briefing sent successfully');

    } catch (error) {
      log.cron('Morning briefing failed', error.message);
    }
  }, {
    timezone: "Asia/Kolkata"
  });

  console.log('[CRON] Morning briefing scheduled for 8:00 AM IST.');
}