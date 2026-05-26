import fs from 'fs/promises';
import path from 'path';
import os from 'os';

const SIA_HOME = path.join(os.homedir(), '.sia');
const MEMORIES_DIR = path.join(SIA_HOME, 'memories');
const USER_FILE = path.join(MEMORIES_DIR, 'USER.md');
const ENV_FILE = path.join(MEMORIES_DIR, 'MEMORY.md');

const MAX_USER_SIZE = 1400;    // characters
const MAX_ENV_SIZE = 2200;

// Ensure directories exist
export async function initMemoryFiles() {
  await fs.mkdir(MEMORIES_DIR, { recursive: true });
  for (const file of [USER_FILE, ENV_FILE]) {
    try {
      await fs.access(file);
    } catch {
      await fs.writeFile(file, '# Empty memory file\n\n');
    }
  }
}

// Read a memory file
export async function readMemoryFile(type) {
  const file = type === 'user' ? USER_FILE : ENV_FILE;
  const content = await fs.readFile(file, 'utf-8');
  return { status: 'success', content };
}

// Write to memory file with size enforcement
export async function writeMemoryFile(type, operation, data) {
  const file = type === 'user' ? USER_FILE : ENV_FILE;
  const maxSize = type === 'user' ? MAX_USER_SIZE : MAX_ENV_SIZE;
  let current = await fs.readFile(file, 'utf-8');

  let newContent;
  if (operation === 'append') {
    newContent = current + '\n' + data;
  } else if (operation === 'replace_line') {
    const lines = current.split('\n');
    const [lineNum, newLine] = data.split('|');
    lines[parseInt(lineNum)] = newLine;
    newContent = lines.join('\n');
  } else if (operation === 'remove_line') {
    const lines = current.split('\n');
    lines.splice(parseInt(data), 1);
    newContent = lines.join('\n');
  } else {
    return { status: 'error', error: 'Invalid operation' };
  }

  // Enforce size limit
  if (newContent.length > maxSize) {
    return { status: 'error', error: `Memory would exceed ${maxSize} chars. Compress first.` };
  }
  await fs.writeFile(file, newContent);
  return { status: 'success', details: `Updated ${type} memory.` };
}

// Compress memory file (ask LLM to summarise)
export async function compressMemory(type, llmSummarizeFn) {
  const file = type === 'user' ? USER_FILE : ENV_FILE;
  const maxSize = type === 'user' ? MAX_USER_SIZE : MAX_ENV_SIZE;
  const content = await fs.readFile(file, 'utf-8');
  if (content.length <= maxSize) return { status: 'success', message: 'No compression needed' };

  const summary = await llmSummarizeFn(content, maxSize);
  await fs.writeFile(file, summary);
  return { status: 'success', details: 'Memory compressed.' };
}