const levels = {
  info:  '\x1b[32m[INFO]\x1b[0m',
  warn:  '\x1b[33m[WARN]\x1b[0m',
  error: '\x1b[31m[ERROR]\x1b[0m',
  cron:  '\x1b[35m[CRON]\x1b[0m',
  agent: '\x1b[36m[AGENT]\x1b[0m',
  tool:  '\x1b[34m[TOOL]\x1b[0m',
  db:    '\x1b[90m[DB]\x1b[0m',
};

function timestamp() {
  return new Date().toISOString().replace('T', ' ').split('.')[0];
}

export const log = {
  info:  (msg, data) => console.log(`${levels.info}  ${timestamp()} ${msg}`, data ?? ''),
  warn:  (msg, data) => console.warn(`${levels.warn}  ${timestamp()} ${msg}`, data ?? ''),
  error: (msg, data) => console.error(`${levels.error} ${timestamp()} ${msg}`, data ?? ''),
  cron:  (msg, data) => console.log(`${levels.cron}  ${timestamp()} ${msg}`, data ?? ''),
  agent: (msg, data) => console.log(`${levels.agent} ${timestamp()} ${msg}`, data ?? ''),
  tool:  (msg, data) => console.log(`${levels.tool}  ${timestamp()} ${msg}`, data ?? ''),
  db:    (msg, data) => console.log(`${levels.db}    ${timestamp()} ${msg}`, data ?? ''),
};