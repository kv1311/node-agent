import { Router } from 'express';
import db from '../config/database.js';

const router = Router();

router.get('/finance/transactions', async (req, res) => {
  try {
    const { limit = 20, month } = req.query;
    let sql = 'SELECT * FROM transactions';
    const args = [];
    if (month) {
      sql += " WHERE date LIKE ?";
      args.push(`${month}%`);
    }
    sql += ' ORDER BY date DESC LIMIT ?';
    args.push(parseInt(limit));
    const result = await db.execute({ sql, args });
    res.json(result.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/finance/summary', async (req, res) => {
  try {
    const month = new Date().toISOString().slice(0, 7);
    const [totals, categories] = await Promise.all([
      db.execute({
        sql: `SELECT type, SUM(amount) as total FROM transactions WHERE date LIKE ? GROUP BY type`,
        args: [`${month}%`]
      }),
      db.execute({
        sql: `SELECT category, SUM(amount) as total FROM transactions WHERE date LIKE ? AND type = 'outflow' GROUP BY category ORDER BY total DESC LIMIT 5`,
        args: [`${month}%`]
      })
    ]);
    res.json({ month, totals: totals.rows, top_categories: categories.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

export default router;