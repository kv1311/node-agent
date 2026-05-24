import cron from 'node-cron'
import db from '../config/database.js'
import { log } from '../utils/log.js'

export function startReminderChecker(bot) {
  // Run every minute
  cron.schedule('* * * * *', async () => {
    try {
      const now = new Date()
      const nowISO = now.toISOString()

      // Find reminders that:
      // 1. Are not marked done
      // 2. Have a remind_at time set
      // 3. The remind_at time is in the past or NOW
      // 4. Haven't been fired yet
      const result = await db.execute({
        sql: `SELECT id, title, remind_at FROM reminders 
              WHERE done = 0 
              AND remind_at IS NOT NULL
              AND remind_at != ''
              AND remind_at <= ?
              AND (fired_at IS NULL OR fired_at = '')
              ORDER BY remind_at ASC
              LIMIT 10`,
        args: [nowISO],
      })

      if (result.rows.length === 0) return

      for (const reminder of result.rows) {
        try {
          // Send Telegram message
          const msg = `⏰ ${reminder.title}`
          await bot.telegram.sendMessage(
            process.env.TELEGRAM_CHAT_ID,
            msg,
          )

          // Mark as fired
          await db.execute({
            sql: `UPDATE reminders SET fired_at = ?, done = 1 WHERE id = ?`,
            args: [nowISO, reminder.id],
          })

          log.cron(`Reminder fired: ${reminder.title} at ${reminder.remind_at}`)
        } catch (e) {
          log.error(`[REMINDER] Failed to fire ${reminder.id}:`, e.message)
        }
      }
    } catch (error) {
      log.error('[REMINDER CHECKER]', error.message)
    }
  })

  log.cron('Reminder checker started — runs every minute')
}