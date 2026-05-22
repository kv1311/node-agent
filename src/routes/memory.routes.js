import { Router } from 'express';
import db from '../config/database.js';

const router = Router();

router.get('/memory', async (req, res) => {
  try {
    const result = await db.execute(
      `SELECT canonical_key, label, type, metadata, updated_at 
       FROM Nodes WHERE is_active = 1 
       ORDER BY updated_at DESC LIMIT 50`
    );
    res.json(result.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/memory/graph', async (req, res) => {
  try {
    const [nodes, edges] = await Promise.all([
      db.execute(`SELECT id, label, type, canonical_key FROM Nodes WHERE is_active = 1`),
      db.execute(`SELECT source_id, target_id, relation, weight FROM Edges`)
    ]);
    res.json({ nodes: nodes.rows, edges: edges.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

export default router;