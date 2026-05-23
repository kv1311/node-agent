import morgan from 'morgan';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const logDir = path.join(__dirname, '../../logs');
if (!fs.existsSync(logDir)) fs.mkdirSync(logDir);

const logStream = fs.createWriteStream(
  path.join(logDir, 'access.log'),
  { flags: 'a' }
);

export const requestLogger = morgan(
  '[:date[iso]] :method :url :status :response-time ms',
  { stream: logStream }
);

export const consoleLogger = morgan(
  '\x1b[36m[:date[iso]]\x1b[0m :method :url \x1b[33m:status\x1b[0m :response-time ms',
);