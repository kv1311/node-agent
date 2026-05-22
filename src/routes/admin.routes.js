import { Router } from 'express';
import os from 'os';
import { execSync } from 'child_process';
import db from '../config/database.js';
import fs from 'fs';

const router = Router();

router.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: Math.floor(process.uptime()), agent: 'Sia' });
});

router.get('/admin/stats', async (req, res) => {
  try {
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;

    // CPU usage (simple load average)
    const loadAvg = os.loadavg()[0];
    const cpuCount = os.cpus().length;
    const cpuPercent = Math.min(Math.round((loadAvg / cpuCount) * 100), 100);

    // Disk usage
    let disk = { used: '?', total: '?', percent: '?' };
    try {
      const dfOut = execSync("df -h / | tail -1").toString().trim().split(/\s+/);
      disk = { total: dfOut[1], used: dfOut[2], percent: dfOut[4] };
    } catch (_) {}

    // DB stats
    const [txCount, nodeCount, convCount, dbSize] = await Promise.all([
      db.execute('SELECT COUNT(*) as count FROM transactions'),
      db.execute('SELECT COUNT(*) as count FROM Nodes WHERE is_active = 1'),
      db.execute('SELECT COUNT(*) as count FROM conversations'),
      Promise.resolve((() => {
        try {
          const stat = fs.statSync('./agent.db');
          return (stat.size / 1024 / 1024).toFixed(2) + ' MB';
        } catch { return '?'; }
      })())
    ]);

    // PM2 process info
    let pm2Info = null;
    try {
      const raw = execSync('pm2 jlist 2>/dev/null').toString();
      const list = JSON.parse(raw);
      const proc = list[0];
      if (proc) {
        pm2Info = {
          name: proc.name,
          status: proc.pm2_env.status,
          restarts: proc.pm2_env.restart_time,
          uptime: proc.pm2_env.pm_uptime,
          memory_mb: Math.round(proc.monit.memory / 1024 / 1024)
        };
      }
    } catch (_) {}

    // Recent logs
    let logs = [];
    try {
      const raw = execSync('pm2 logs --nostream --lines 20 2>/dev/null').toString();
      logs = raw.split('\n').filter(Boolean).slice(-20);
    } catch (_) {}

    res.json({
      system: {
        cpu_percent: cpuPercent,
        ram_used_mb: Math.round(usedMem / 1024 / 1024),
        ram_total_mb: Math.round(totalMem / 1024 / 1024),
        ram_percent: Math.round((usedMem / totalMem) * 100),
        disk,
        node_uptime_s: Math.floor(process.uptime())
      },
      database: {
        transactions: txCount.rows[0].count,
        memory_nodes: nodeCount.rows[0].count,
        conversations: convCount.rows[0].count,
        size: dbSize
      },
      pm2: pm2Info,
      logs
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;