import { Router } from 'express';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.join(__dirname, '../..'); // assuming routes are in src/routes/
const MEMORIES_DIR = path.join(PROJECT_ROOT, 'memories');
const USER_FILE = path.join(MEMORIES_DIR, 'USER.md');
const ENV_FILE = path.join(MEMORIES_DIR, 'MEMORY.md');
const SKILLS_DIR = path.join(MEMORIES_DIR, 'skills');

const router = Router();

// GET /api/memory - returns USER.md and MEMORY.md content
router.get('/memory', async (req, res) => {
  try {
    let userContent = '';
    let envContent = '';
    try {
      userContent = await fs.readFile(USER_FILE, 'utf-8');
    } catch {
      userContent = '# User Profile\n\n(No USER.md found)';
    }
    try {
      envContent = await fs.readFile(ENV_FILE, 'utf-8');
    } catch {
      envContent = '# Environment Memory\n\n(No MEMORY.md found)';
    }
    res.json({
      user: userContent,
      env: envContent,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/memory/skills - list all skill files (optional)
router.get('/memory/skills', async (req, res) => {
  try {
    await fs.mkdir(SKILLS_DIR, { recursive: true });
    const files = await fs.readdir(SKILLS_DIR);
    const skills = files.filter(f => f.endsWith('.md')).map(f => f.replace(/\.md$/, ''));
    res.json({ skills });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/memory/skills/:name - return a specific skill file
router.get('/memory/skills/:name', async (req, res) => {
  try {
    const skillPath = path.join(SKILLS_DIR, `${req.params.name}.md`);
    const content = await fs.readFile(skillPath, 'utf-8');
    res.json({ name: req.params.name, content });
  } catch (e) {
    res.status(404).json({ error: 'Skill not found' });
  }
});

// POST /api/memory/skills - create or update a skill
router.post('/memory/skills', async (req, res) => {
  const { name, content } = req.body;
  if (!name || !content) {
    return res.status(400).json({ error: 'name and content are required' });
  }
  try {
    await fs.mkdir(SKILLS_DIR, { recursive: true });
    const skillPath = path.join(SKILLS_DIR, `${name}.md`);
    await fs.writeFile(skillPath, content);
    res.json({ success: true, name });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/memory/skills/:name
router.delete('/memory/skills/:name', async (req, res) => {
  try {
    const skillPath = path.join(SKILLS_DIR, `${req.params.name}.md`);
    await fs.unlink(skillPath);
    res.json({ success: true });
  } catch (e) {
    res.status(404).json({ error: 'Skill not found' });
  }
});

// The old /memory/graph endpoint is removed because graph memory is no longer used.
// If you still need a graph view, you could implement one from the obligations/accounts tables.

export default router;