// src/queue/backgroundQueue.js
const queue = [];
let processing = false;

export function enqueue(name, fn) {
  queue.push({ name, fn });
  processQueue();
}

async function processQueue() {
  if (processing) return;
  processing = true;
  while (queue.length) {
    const job = queue.shift();
    try {
      console.log(`[BACKGROUND] Running ${job.name}`);
      await job.fn();
      await new Promise(r => setTimeout(r, 500)); // rate limit
    } catch (err) {
      console.error(`[BACKGROUND] ${job.name} failed:`, err.message);
    }
  }
  processing = false;
}