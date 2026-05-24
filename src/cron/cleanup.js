// src/cron/cleanup.js
// Runs nightly at 3am — prevents conversations table from growing unbounded
// Import and call startCleanup(bot) in index.js same as morning.js

import cron from 'node-cron'
import db from '../config/database.js'
import { log } from '../utils/log.js'

export function startCleanup() {
  // Run at 3:00 AM every day
  cron.schedule('0 3 * * *', async () => {
    try {
      // Delete conversations older than 30 days
      const result = await db.execute({
        sql: `DELETE FROM conversations WHERE created_at < datetime('now', '-30 days')`,
        args: [],
      })
      log.info(`[CRON] Cleanup: removed old conversations`)

      // Also clean up soft-deleted nodes older than 90 days
      await db.execute({
        sql: `DELETE FROM Nodes WHERE is_active = 0 AND updated_at < datetime('now', '-90 days')`,
        args: [],
      })
      log.info(`[CRON] Cleanup: pruned inactive memory nodes`)

    } catch (err) {
      log.error('[CRON] Cleanup failed:', err.message)
    }
  }, { timezone: 'Asia/Kolkata' })

  log.info('[CRON] Cleanup scheduler started')
}