import { Router } from 'express';
import db from '../config/database.js';

const router = Router();

router.get('/journal', async (req, res) => {
  try {
    const { limit = 20, keyword } = req.query;
    let sql = `SELECT id, title, mood, tags, created_at, SUBSTR(content, 1, 150) as preview 
               FROM journal`;
    const args = [];
    if (keyword) {
      sql += ` WHERE content LIKE ? OR title LIKE ? OR tags LIKE ?`;
      args.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`);
    }
    sql += ` ORDER BY created_at DESC LIMIT ?`;
    args.push(parseInt(limit));
    const result = await db.execute({ sql, args });
    res.json(result.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/journal/:id', async (req, res) => {
  try {
    const result = await db.execute({
      sql: `SELECT * FROM journal WHERE id = ?`,
      args: [req.params.id]
    });
    if (result.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    res.json(result.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/journal/:id', async (req, res) => {
  try {
    await db.execute({ sql: `DELETE FROM journal WHERE id = ?`, args: [req.params.id] });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

export default router;