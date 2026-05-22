import { Router } from 'express';
import db from '../config/database.js';
import { v4 as uuidv4 } from 'uuid';

const router = Router();

router.get('/watchlist', async (req, res) => {
  try {
    const result = await db.execute('SELECT * FROM watchlist ORDER BY title ASC');
    res.json(result.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/watchlist', async (req, res) => {
  const { title, type, genre } = req.body;
  if (!title?.trim()) return res.status(400).json({ error: 'title is required' });
  const id = uuidv4();
  try {
    await db.execute({
      sql: 'INSERT INTO watchlist (id, title, type, genre, watched) VALUES (?, ?, ?, ?, 0)',
      args: [id, title, type || 'movie', genre || '']
    });
    res.json({ id, title, type: type || 'movie', genre: genre || '', watched: false });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.patch('/watchlist/:id', async (req, res) => {
  const { watched } = req.body;
  try {
    await db.execute({ sql: 'UPDATE watchlist SET watched = ? WHERE id = ?', args: [watched ? 1 : 0, req.params.id] });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/watchlist/:id', async (req, res) => {
  try {
    await db.execute({ sql: 'DELETE FROM watchlist WHERE id = ?', args: [req.params.id] });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

export default router;