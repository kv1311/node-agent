// ADD THIS to your Express backend — new file: src/routes/data.routes.js
// This is the single endpoint the UI calls on load and after every chat action

import { Router } from 'express'
import db from '../config/database.js'

const router = Router()

router.get('/data', async (req, res) => {
  try {
    const [
      tasks,
      reminders,
      bills,
      events,
      watchlist,
      memory,
      totals,
      categories,
    ] = await Promise.all([
      db.execute('SELECT * FROM tasks ORDER BY created_at DESC LIMIT 20'),
      db.execute('SELECT * FROM reminders ORDER BY remind_at ASC LIMIT 10'),
      db.execute('SELECT * FROM bills ORDER BY due_date ASC LIMIT 10'),
      db.execute('SELECT * FROM events ORDER BY date ASC LIMIT 10'),
      db.execute('SELECT * FROM watchlist ORDER BY title ASC LIMIT 20'),
      db.execute(
        'SELECT canonical_key, label, type, updated_at FROM Nodes WHERE is_active = 1 ORDER BY updated_at DESC LIMIT 20',
      ),
      db.execute(`
        SELECT type, SUM(amount) as total
        FROM transactions
        WHERE date LIKE ?
        GROUP BY type
      `, [`${new Date().toISOString().slice(0, 7)}%`]),
      db.execute(`
        SELECT category, SUM(amount) as total
        FROM transactions
        WHERE date LIKE ? AND type = 'outflow'
        GROUP BY category
        ORDER BY total DESC
        LIMIT 5
      `, [`${new Date().toISOString().slice(0, 7)}%`]),
    ])

    res.json({
      tasks: tasks.rows,
      reminders: reminders.rows,
      bills: bills.rows,
      events: events.rows,
      watchlist: watchlist.rows,
      memory: memory.rows,
      finance_summary: {
        month: new Date().toISOString().slice(0, 7),
        totals: totals.rows,
        top_categories: categories.rows,
      },
    })
  } catch (e) {
    const err = e instanceof Error ? e.message : 'Unknown error'
    res.status(500).json({ error: err })
  }
})

export default router
