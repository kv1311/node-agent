import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import db from '../config/database.js';

const router = Router();

router.get('/tasks', async (req, res) => {
  try {
    const result = await db.execute('SELECT * FROM tasks ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/tasks', async (req, res) => {
  const { title, due_date } = req.body;
  if (!title?.trim()) return res.status(400).json({ error: 'title is required' });
  const id = uuidv4();
  try {
    await db.execute({
      sql: `INSERT INTO tasks (id, title, due_date, done) VALUES (?, ?, ?, 0)`,
      args: [id, title, due_date || '']
    });
    res.json({ id, title, due_date: due_date || '', done: false });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.patch('/tasks/:id', async (req, res) => {
  const { done, title } = req.body;
  try {
    if (done !== undefined) await db.execute({ sql: `UPDATE tasks SET done = ? WHERE id = ?`, args: [done ? 1 : 0, req.params.id] });
    if (title !== undefined) await db.execute({ sql: `UPDATE tasks SET title = ? WHERE id = ?`, args: [title, req.params.id] });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/tasks/:id', async (req, res) => {
  try {
    await db.execute({ sql: `DELETE FROM tasks WHERE id = ?`, args: [req.params.id] });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Reminders
router.get('/reminders', async (req, res) => {
  try {
    const result = await db.execute('SELECT * FROM reminders ORDER BY remind_at ASC');
    res.json(result.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/reminders', async (req, res) => {
  const { title, remind_at } = req.body;
  if (!title?.trim()) return res.status(400).json({ error: 'title is required' });
  const id = uuidv4();
  try {
    await db.execute({
      sql: `INSERT INTO reminders (id, title, remind_at, done) VALUES (?, ?, ?, 0)`,
      args: [id, title, remind_at || '']
    });
    res.json({ id, title, remind_at: remind_at || '', done: false });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.patch('/reminders/:id', async (req, res) => {
  const { done, title } = req.body;
  try {
    if (done !== undefined) await db.execute({ sql: `UPDATE reminders SET done = ? WHERE id = ?`, args: [done ? 1 : 0, req.params.id] });
    if (title !== undefined) await db.execute({ sql: `UPDATE reminders SET title = ? WHERE id = ?`, args: [title, req.params.id] });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/reminders/:id', async (req, res) => {
  try {
    await db.execute({ sql: `DELETE FROM reminders WHERE id = ?`, args: [req.params.id] });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Bills
router.get('/bills', async (req, res) => {
  try {
    const result = await db.execute('SELECT * FROM bills ORDER BY due_date ASC');
    res.json(result.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/bills', async (req, res) => {
  const { title, amount, due_date } = req.body;
  if (!title?.trim()) return res.status(400).json({ error: 'title is required' });
  const id = uuidv4();
  try {
    await db.execute({
      sql: `INSERT INTO bills (id, title, amount, due_date, paid) VALUES (?, ?, ?, ?, 0)`,
      args: [id, title, amount || 0, due_date || '']
    });
    res.json({ id, title, amount: amount || 0, due_date: due_date || '', paid: false });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.patch('/bills/:id', async (req, res) => {
  const { paid } = req.body;
  try {
    await db.execute({ sql: `UPDATE bills SET paid = ? WHERE id = ?`, args: [paid ? 1 : 0, req.params.id] });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Events
router.get('/events', async (req, res) => {
  try {
    const result = await db.execute('SELECT * FROM events ORDER BY date ASC');
    res.json(result.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/events', async (req, res) => {
  const { title, date, notes } = req.body;
  if (!title?.trim()) return res.status(400).json({ error: 'title is required' });
  const id = uuidv4();
  try {
    await db.execute({
      sql: `INSERT INTO events (id, title, date, notes) VALUES (?, ?, ?, ?)`,
      args: [id, title, date || '', notes || '']
    });
    res.json({ id, title, date: date || '', notes: notes || '' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.patch('/events/:id', async (req, res) => {
  const { title, date, notes } = req.body;
  try {
    if (title) await db.execute({ sql: `UPDATE events SET title = ? WHERE id = ?`, args: [title, req.params.id] });
    if (date) await db.execute({ sql: `UPDATE events SET date = ? WHERE id = ?`, args: [date, req.params.id] });
    if (notes) await db.execute({ sql: `UPDATE events SET notes = ? WHERE id = ?`, args: [notes, req.params.id] });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Watchlist
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
      sql: `INSERT INTO watchlist (id, title, type, genre, watched) VALUES (?, ?, ?, ?, 0)`,
      args: [id, title, type || 'movie', genre || '']
    });
    res.json({ id, title, type: type || 'movie', genre: genre || '', watched: false });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.patch('/watchlist/:id', async (req, res) => {
  const { watched } = req.body;
  try {
    await db.execute({ sql: `UPDATE watchlist SET watched = ? WHERE id = ?`, args: [watched ? 1 : 0, req.params.id] });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Memory
router.get('/memory', async (req, res) => {
  try {
    const result = await db.execute(
      `SELECT canonical_key, label, type, updated_at 
       FROM Nodes WHERE is_active = 1 
       ORDER BY updated_at DESC LIMIT 20`
    );
    res.json(result.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

export default router;