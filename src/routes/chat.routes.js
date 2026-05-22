import { Router } from 'express';
import { generateResponse } from '../ai/groq.js';

const router = Router();

router.post('/chat', async (req, res) => {
  const { message, session_id } = req.body;
  if (!message?.trim()) return res.status(400).json({ error: 'message is required' });
  try {
    const reply = await generateResponse(message, null, session_id || 'web-default');
    res.json({ reply });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

export default router;