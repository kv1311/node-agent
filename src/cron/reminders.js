// src/cron/reminders.js
import cron from 'node-cron'
import db from '../config/database.js'
import { log } from '../utils/log.js'

export function startReminderChecker(bot) {
  // Runs every minute
  cron.schedule('* * * * *', async () => {
    try {
      const now = new Date()
      const nowStr = now.toISOString()
      
      // Find reminders due in the last 2 minutes that haven't fired
      const result = await db.execute({
        sql: `SELECT * FROM reminders 
              WHERE done = 0 
              AND remind_at != ''
              AND remind_at <= ?
              AND (fired_at IS NULL OR fired_at = '')
              LIMIT 5`,
        args: [nowStr]
      })

      for (const reminder of result.rows) {
        await bot.telegram.sendMessage(
          process.env.TELEGRAM_CHAT_ID,
          `⏰ ${reminder.title}`
        )
        
        // Mark as fired
        await db.execute({
          sql: `UPDATE reminders SET fired_at = ? WHERE id = ?`,
          args: [nowStr, reminder.id]
        })
        
        log.cron(`Reminder fired: ${reminder.title}`)
      }
    } catch (error) {
      log.error('Reminder checker failed', error.message)
    }
  })
  
  log.cron('Reminder checker started — running every minute')
}