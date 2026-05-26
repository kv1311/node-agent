import Groq from 'groq-sdk';
import { GoogleGenerativeAI } from '@google/generative-ai';
import 'dotenv/config';
import { v4 as uuidv4 } from 'uuid';
import { logTransaction, editTransaction } from '../tools/finance.js';
import { readMemoryFile, writeMemoryFile, searchSessions, initMemoryFiles } from '../tools/memory.js';
import { manageTask, manageReminder, manageBill, manageEvent, manageWatchlist, getContext } from '../tools/tasks.js';
import { analyzeFinances, getRecentTransactions } from '../tools/analyze.js';
import { syncDashboardMemory } from '../tools/workspace.js';
import db from '../config/database.js';
import { webSearch } from '../tools/search.js';
import { log } from '../utils/log.js';
import { manageJournal } from '../tools/journal.js';
import {
  createObligation,
  recordSettlement,
  queryObligations,
  updateBalance,
  getObligationDetail,
} from '../tools/obligations.js';

// ── Clients ───────────────────────────────────────────────────────────────────

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const gemini = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// ── Background queue ──────────────────────────────────────────────────────────

const jobQueue = [];
let processing = false;
const pendingReplies = new Map();

function enqueue(name, fn) {
  jobQueue.push({ name, fn });
  if (!processing) processQueue();
}

async function processQueue() {
  if (processing) return;
  processing = true;
  while (jobQueue.length) {
    const job = jobQueue.shift();
    try {
      log.info(`[QUEUE] Running ${job.name}`);
      await job.fn();
      await new Promise(r => setTimeout(r, 500));
    } catch (err) {
      log.error(`[QUEUE] ${job.name} failed:`, err.message);
    }
  }
  processing = false;
}

async function storeDelayedResponse(sessionId, reply) {
  pendingReplies.set(sessionId, reply);
  log.info(`[BACKGROUND] Stored reply for ${sessionId}`);
}

// ── Tool definitions ──────────────────────────────────────────────────────────

const TOOL_DEFS = {
  finance: [
    {
      type: 'function',
      function: {
        name: 'log_transaction',
        description: 'Log a confirmed financial transaction.',
        parameters: {
          type: 'object',
          properties: {
            amount: { type: 'number' },
            type: { type: 'string', enum: ['inflow', 'outflow'] },
            category: { type: 'string' },
            description: { type: 'string' },
            account_source: { type: 'string' },
            date: { type: 'string', description: 'YYYY-MM-DD' },
          },
          required: ['amount', 'type', 'category', 'description'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'edit_transaction',
        description: 'Fix an existing transaction.',
        parameters: {
          type: 'object',
          properties: {
            search_description: { type: 'string' },
            new_amount: { type: 'number' },
            new_date: { type: 'string' },
          },
          required: ['search_description'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'analyze_finances',
        description: 'Query spending data.',
        parameters: {
          type: 'object',
          properties: {
            time_frame: { type: 'string', enum: ['current_month', 'last_month', 'all'] },
          },
          required: ['time_frame'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'get_recent_transactions',
        description: 'Fetch recent transactions.',
        parameters: { type: 'object', properties: { limit: { type: 'integer' } } },
      },
    },
    {
      type: 'function',
      function: {
        name: 'sync_dashboard_memory',
        description: 'Sync financial data from Google Sheets.',
        parameters: {
          type: 'object',
          properties: {
            spreadsheet_id: { type: 'string' },
            tab_name: { type: 'string' },
          },
          required: ['spreadsheet_id', 'tab_name'],
        },
      },
    },
  ],

  obligations: [
    {
      type: 'function',
      function: {
        name: 'create_obligation',
        description: 'Create a financial obligation between two parties — loans, credit cards, debts, rent, bills.',
        parameters: {
          type: 'object',
          properties: {
            from: { type: 'string', description: 'Who owes (e.g., "me", "Ramesh", "Kotak Bank").' },
            to: { type: 'string', description: 'Who is owed.' },
            amount: { type: 'number' },
            currency: { type: 'string', default: 'INR' },
            due_date: { type: 'string', description: 'YYYY-MM-DD (optional).' },
            installments: { type: 'integer', description: 'Number of installments (default 1).' },
            purpose: { type: 'string', description: 'loan, credit_card, rent, bill, personal_debt, investment, subscription.' },
            notes: { type: 'string' },
          },
          required: ['from', 'to', 'amount', 'purpose'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'record_settlement',
        description: 'Record a payment towards an obligation (full or partial).',
        parameters: {
          type: 'object',
          properties: {
            obligation_id: { type: 'string' },
            amount_paid: { type: 'number' },
            payment_date: { type: 'string', description: 'YYYY-MM-DD (default: today).' },
            from_account: { type: 'string' },
            notes: { type: 'string' },
          },
          required: ['obligation_id', 'amount_paid'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'query_obligations',
        description: 'Query current obligations. Use for "How much does X owe me?" or "What do I owe X?"',
        parameters: {
          type: 'object',
          properties: {
            party: { type: 'string', description: 'Name of party. Leave empty for all.' },
            type: { type: 'string', enum: ['creditor', 'debtor', 'any'], description: 'creditor = they owe me, debtor = I owe them.' },
            status: { type: 'string', enum: ['active', 'settled', 'any'], default: 'active' },
          },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'get_obligation_detail',
        description: 'Get full history of a single obligation with all payments.',
        parameters: {
          type: 'object',
          properties: { obligation_id: { type: 'string' } },
          required: ['obligation_id'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'update_balance',
        description: 'Update account or asset balance. Use for bank balances and wallet amounts — NOT obligations.',
        parameters: {
          type: 'object',
          properties: {
            account: { type: 'string', description: 'Account name (e.g., "Kotak", "Slice", "Cash").' },
            amount: { type: 'number', description: 'Current balance.' },
            currency: { type: 'string', default: 'INR' },
          },
          required: ['account', 'amount'],
        },
      },
    },
  ],

  tasks: [
    {
      type: 'function',
      function: {
        name: 'manage_task',
        description: 'Create, complete, delete, or list tasks.',
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['create', 'complete', 'delete', 'list'] },
            title: { type: 'string' },
            due_date: { type: 'string' },
            keyword: { type: 'string' },
          },
          required: ['action'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'manage_reminder',
        description: 'Create, complete, delete, or list reminders.',
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['create', 'complete', 'delete', 'list'] },
            title: { type: 'string' },
            remind_at: { type: 'string' },
            keyword: { type: 'string' },
          },
          required: ['action'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'manage_bill',
        description: 'Create, mark paid, delete, or list bills.',
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['create', 'mark_paid', 'delete', 'list'] },
            title: { type: 'string' },
            amount: { type: 'number' },
            due_date: { type: 'string' },
            keyword: { type: 'string' },
          },
          required: ['action'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'manage_event',
        description: 'Create, delete, or list events.',
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['create', 'delete', 'list'] },
            title: { type: 'string' },
            date: { type: 'string' },
            notes: { type: 'string' },
            keyword: { type: 'string' },
          },
          required: ['action'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'manage_watchlist',
        description: 'Add, mark watched, delete, or list movies and shows.',
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['create', 'mark_watched', 'delete', 'list'] },
            title: { type: 'string' },
            type: { type: 'string', enum: ['movie', 'series', 'documentary'] },
            genre: { type: 'string' },
            keyword: { type: 'string' },
          },
          required: ['action'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'get_context',
        description: "Get today's snapshot: pending tasks, reminders, unpaid bills, upcoming events.",
        parameters: { type: 'object', properties: {} },
      },
    },
  ],

  journal: [
    {
      type: 'function',
      function: {
        name: 'manage_journal',
        description: 'Write, read, list, search, or delete journal entries.',
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['write', 'list', 'read', 'search', 'delete'] },
            title: { type: 'string' },
            content: { type: 'string' },
            mood: { type: 'string' },
            tags: { type: 'array', items: { type: 'string' } },
            session_id: { type: 'string' },
            keyword: { type: 'string' },
            limit: { type: 'integer' },
          },
          required: ['action'],
        },
      },
    },
  ],

  search: [
    {
      type: 'function',
      function: {
        name: 'web_search',
        description: 'Search the web for current information.',
        parameters: {
          type: 'object',
          properties: { query: { type: 'string' }, count: { type: 'integer' } },
          required: ['query'],
        },
      },
    },
  ],

  memory: [
    {
      type: 'function',
      function: {
        name: 'read_memory',
        description: 'Read USER.md (personal profile) or MEMORY.md (environment facts).',
        parameters: {
          type: 'object',
          properties: { file: { type: 'string', enum: ['user', 'env'] } },
          required: ['file']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'write_memory',
        description: 'Append, replace a line, or remove a line from a memory file. Use "append" for new facts. Use "replace_line" with "lineNumber|newText". Use "remove_line" with line number.',
        parameters: {
          type: 'object',
          properties: {
            file: { type: 'string', enum: ['user', 'env'] },
            operation: { type: 'string', enum: ['append', 'replace_line', 'remove_line'] },
            data: { type: 'string' }
          },
          required: ['file', 'operation', 'data']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'search_sessions',
        description: 'Search past conversations using full‑text search.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string' },
            limit: { type: 'integer', default: 5 }
          },
          required: ['query']
        }
      }
    }
  ],
};

// ── Intent classifier ─────────────────────────────────────────────────────────

function classifyIntent(prompt) {
  const p = prompt.toLowerCase();

  if (/journal|diary|write.*entry|entry.*write|mood|reflection/i.test(p)) return 'journal';
  if (/\blent\b|\bowed\b|\bowe\b|\bdebt\b|\binstallment\b|\bpay back\b|\bowes me\b|\bowes kv\b|outstanding|remaining|owe.*how much|how much.*owe|who.*owe|owe.*who/i.test(p)) return 'finance';
  if (/spent|paid|expense|₹|\brs\b|transaction|finance|budget|inflow|outflow|credit|debit|kotak|account|balance|invest|slice|transfer/i.test(p)) return 'finance';
  if (/task|todo|to-do|remind|bill|event|watch(list)?|movie|series|show|mark.*done|complete|finish|tick|check off|^done$/i.test(p)) return 'tasks';
  if (/remember|who is|what is|my name|my.*prefer|save.*fact|forget|memory/i.test(p)) return 'memory';
  if (/search|look up|latest|news|current|today.*weather|price of|tell me about|who (is|was)|what (is|was)|explain|describe/i.test(p)) return 'search';
  return 'general';
}

function getToolsForIntent(intent) {
  switch (intent) {
    case 'journal': return TOOL_DEFS.journal;
    case 'finance': return [...TOOL_DEFS.finance, ...TOOL_DEFS.obligations, ...TOOL_DEFS.memory];
    case 'tasks':   return [...TOOL_DEFS.tasks, ...TOOL_DEFS.memory];
    case 'memory':  return TOOL_DEFS.memory;
    case 'search':  return TOOL_DEFS.search;
    default:        return [...TOOL_DEFS.tasks, ...TOOL_DEFS.memory, ...TOOL_DEFS.search];
  }
}

// ── System prompt ─────────────────────────────────────────────────────────────

function buildSystemPrompt(liveContext, today, minimal = false) {
  if (minimal) {
    return `You are Sia, a helpful assistant. Today is ${today}. Answer briefly.`;
  }

  return `You are Sia, a personal agent for the user.

Today's date: ${today}. Use ISO format for times: "${today}T13:00:00".

Memory files (injected below):
- USER.md: user's profile, preferences, rules.
- MEMORY.md: durable facts, projects, environment.

RULES:
- Never invent facts. Use only what is in memory or user messages.
- To remember something, call write_memory (append) to USER.md or MEMORY.md.
- Respect character limits: USER.md ≤1400, MEMORY.md ≤2200. If a write would exceed, call compress_memory first (we'll implement later).
- To recall past conversations, use search_sessions.
- Answer in plain text. No JSON, no function names, no XML.

${liveContext ? `\nCurrent memory:\n${liveContext}\n` : ''}
`;
}

// ── History ───────────────────────────────────────────────────────────────────

async function loadHistory(sessionId, limit = 6) {
  const result = await db.execute({
    sql: `SELECT role, content FROM conversations
          WHERE session_id = ?
          ORDER BY created_at DESC LIMIT ?`,
    args: [sessionId, limit],
  });
  return result.rows.reverse();
}

async function saveHistory(sessionId, role, content) {
  await db.execute({
    sql: `INSERT INTO conversations (id, session_id, role, content) VALUES (?, ?, ?, ?)`,
    args: [uuidv4(), sessionId, role, content],
  });
}

// ── Tool executor ─────────────────────────────────────────────────────────────

async function executeTool(name, args, messageId) {
  try {
    log.tool(`${name} called`, args);
    switch (name) {
      case 'manage_journal':          return await manageJournal(args);
      case 'log_transaction':         return await logTransaction(args, messageId);
      case 'edit_transaction':        return await editTransaction(args);
      case 'analyze_finances':        return await analyzeFinances(args);
      case 'get_recent_transactions': return await getRecentTransactions(args);
      case 'manage_task':             return await manageTask(args);
      case 'manage_reminder':         return await manageReminder(args);
      case 'manage_bill':             return await manageBill(args);
      case 'manage_event':            return await manageEvent(args);
      case 'manage_watchlist':        return await manageWatchlist(args);
      case 'web_search':              return await webSearch(args);
      case 'get_context':             return await getContext();
      case 'sync_dashboard_memory':   return await syncDashboardMemory(args);
      case 'create_obligation':       return await createObligation(args);
      case 'record_settlement':       return await recordSettlement(args);
      case 'query_obligations':       return await queryObligations(args);
      case 'get_obligation_detail':   return await getObligationDetail(args);
      case 'update_balance':          return await updateBalance(args);
      case 'read_memory':             return await readMemoryFile(args.file);
      case 'write_memory':            return await writeMemoryFile(args.file, args.operation, args.data);
      case 'search_sessions':         return await searchSessions(args);
      default:
        return { status: 'Failed', error: `Unknown tool: ${name}` };
    }
  } catch (error) {
    log.tool(`[TOOL ERROR] ${name}:`, error.message);
    return { status: 'Failed', tool: name, error: error.message, recoverable: true };
  }
}

// ── Simple message detector ───────────────────────────────────────────────────

function isSimpleMessage(prompt) {
  const simple = [
    /^(hi|hey|hello|sup|yo|good morning|good night|gm|gn)[\s!?.]*$/i,
    /^(okay|ok|thanks|thank you|got it|right|cool|nice|sure|noted)[\s!?.]*$/i,
    /^what (day|time|date|year) is (it|today|now)/i,
    /^who are you/i,
    /^your name/i,
  ];
  return simple.some(r => r.test(prompt.trim()));
}

// ── Gemini (simple messages + fallback) ──────────────────────────────────────

async function callGemini(messages, systemPrompt) {
  const model = gemini.getGenerativeModel({
    model: 'gemini-2.5-flash-lite',
    systemInstruction: systemPrompt,
    tools: [{ googleSearch: {} }],
  });

  const conversational = messages.filter(
    m => (m.role === 'user' || m.role === 'assistant') &&
         typeof m.content === 'string' &&
         m.content.trim().length > 0
  );

  while (conversational.length > 0 && conversational[0].role === 'assistant') {
    conversational.shift();
  }

  const lastMessage = conversational[conversational.length - 1];
  const priorMessages = conversational.slice(0, -1);

  const geminiHistory = priorMessages.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));

  try {
    const chat = model.startChat({ history: geminiHistory });
    const result = await chat.sendMessage(lastMessage?.content ?? '');
    return result.response.text();
  } catch {
    log.warn('Gemini with history failed, retrying bare');
    const chat = model.startChat({ history: [] });
    const result = await chat.sendMessage(lastMessage?.content ?? '');
    return result.response.text();
  }
}

// ── Groq ──────────────────────────────────────────────────────────────────────

async function callGroq(messages, tools = null) {
  const params = {
    model: tools ? 'llama-3.3-70b-versatile' : 'llama-3.1-8b-instant',
    messages,
    max_tokens: tools ? 1024 : 512,
  };
  if (tools) {
    params.tools = tools;
    params.tool_choice = 'auto';
    params.parallel_tool_calls = false;
  }
  return await groq.chat.completions.create(params);
}

// ── Background ────────────────────────────────────────────────────────────────

function needsBackground(intent) {
  return ['finance_sync', 'weekly_report', 'memory_enrichment'].includes(intent);
}

async function callOpenRouterFree(messages, systemPrompt) {
  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'nvidia/nemotron-3-nano-30b-a3b:free',
      messages: [
        { role: 'system', content: systemPrompt },
        ...messages.filter(m => m.role !== 'system')
      ],
      max_tokens: 1024,
      temperature: 0.7,
    }),
  });
  if (!response.ok) throw new Error(`OpenRouter ${response.status}: ${await response.text()}`);
  const data = await response.json();
  return data.choices[0].message.content;
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function cleanRawToolCalls(text) {
  if (!text) return text;
  return text
    .replace(/<function[^>]*>[\s\S]*?<\/function>/gi, '')
    .replace(/<function[^>]*\/>/gi, '')
    .replace(/`?\{"name":\s*"[^"]+",\s*"arguments":\s*\{[^}]*\}\s*\}`?/g, '')
    .replace(/\[function[^\]]*\]/gi, '')
    .replace(/I will (call|use) \w+\([^)]*\)/gi, '')
    .trim();
}

// ── Main entry point ──────────────────────────────────────────────────────────

export async function generateResponse(prompt, messageId, sessionId = 'telegram-default') {
  try {
    const today = new Date().toISOString().split('T')[0];
    const simple = isSimpleMessage(prompt);
    const intent = simple ? 'simple' : classifyIntent(prompt);

    // Fast path: mark as done
    const markMatch = prompt.match(
      /^(?:mark\s+['"]?(.+?)['"]?\s+as\s+done|complete\s+['"]?(.+?)['"]?|tick\s+['"]?(.+?)['"]?|check\s+off\s+['"]?(.+?)['"]?)$/i
    );
    if (markMatch) {
      const title = (markMatch[1] || markMatch[2] || markMatch[3] || markMatch[4])?.trim();
      if (title) {
        let updated = false;
        let result = await db.execute({
          sql: `UPDATE tasks SET done = 1 WHERE title LIKE ? AND done = 0`,
          args: [`%${title}%`]
        });
        if ((result.rowsAffected ?? result.affectedRows ?? 0) > 0) updated = true;
        if (!updated) {
          result = await db.execute({
            sql: `UPDATE reminders SET done = 1 WHERE title LIKE ? AND done = 0`,
            args: [`%${title}%`]
          });
          if ((result.rowsAffected ?? result.affectedRows ?? 0) > 0) updated = true;
        }
        const reply = updated ? `✓ "${title}" done.` : `No pending task or reminder matched "${title}".`;
        await saveHistory(sessionId, 'user', prompt);
        await saveHistory(sessionId, 'assistant', reply);
        return reply;
      }
    }

    // Load conversation history
    const historyLimit = simple ? 2 : (intent === 'general' ? 6 : 3);
    const history = await loadHistory(sessionId, historyLimit);

    // Load memory files as live context
    let liveContext = '';
    if (!simple) {
      try {
        const userMem = await readMemoryFile('user');
        const envMem = await readMemoryFile('env');
        liveContext = `USER.md:\n${userMem.content}\n\nMEMORY.md:\n${envMem.content}`;
      } catch (err) {
        log.warn('Could not read memory files:', err.message);
        liveContext = '';
      }
    }

    const systemPrompt = buildSystemPrompt(liveContext, today, simple);
    const messages = [
      { role: 'system', content: systemPrompt },
      ...history,
      { role: 'user', content: prompt },
    ];

    log.agent(`Session: ${sessionId} | Intent: ${intent} | "${prompt.slice(0, 50)}"`);

    // Tool intents: Groq only, no Gemini fallback
    const toolIntents = ['memory', 'finance', 'tasks', 'journal'];
    if (toolIntents.includes(intent)) {
      const selectedTools = getToolsForIntent(intent);
      try {
        const response = await callGroq(messages, selectedTools);
        const responseMessage = response.choices[0].message;

        if (responseMessage.tool_calls) {
          messages.push(responseMessage);
          for (const toolCall of responseMessage.tool_calls) {
            const args = JSON.parse(toolCall.function.arguments);
            const result = await executeTool(toolCall.function.name, args, messageId);
            messages.push({
              tool_call_id: toolCall.id,
              role: 'tool',
              name: toolCall.function.name,
              content: JSON.stringify(result),
            });
          }
          const finalResponse = await groq.chat.completions.create({
            model: 'llama-3.1-8b-instant',
            messages,
            max_tokens: 512,
          });
          let reply = finalResponse.choices[0].message.content || 'Done.';
          reply = cleanRawToolCalls(reply);
          await saveHistory(sessionId, 'user', prompt);
          await saveHistory(sessionId, 'assistant', reply);
          return reply;
        }

        // No tool calls
        let reply = responseMessage.content || '.';
        reply = cleanRawToolCalls(reply);
        await saveHistory(sessionId, 'user', prompt);
        await saveHistory(sessionId, 'assistant', reply);
        return reply;
      } catch (groqError) {
        log.error(`Groq failed for tool intent ${intent}:`, groqError.message);
        return 'Tool‑based request failed. Try again later.';
      }
    }

    // Simple messages → Gemini (no tools)
    if (simple) {
      try {
        const reply = await callGemini(messages, systemPrompt);
        const cleaned = cleanRawToolCalls(reply?.trim() || '.');
        await saveHistory(sessionId, 'user', prompt);
        await saveHistory(sessionId, 'assistant', cleaned);
        return cleaned;
      } catch (geminiErr) {
        log.warn('Gemini simple path failed, falling back to Groq:', geminiErr?.message);
        // fall through
      }
    }

    // General intent (non‑tool)
    try {
      const response = await callGroq(messages, null);
      let reply = response.choices[0].message.content || '.';
      reply = cleanRawToolCalls(reply);
      await saveHistory(sessionId, 'user', prompt);
      await saveHistory(sessionId, 'assistant', reply);
      return reply;
    } catch (groqError) {
      log.warn(`Groq general failed, trying Gemini: ${groqError.message}`);
      try {
        const reply = await callGemini(messages, systemPrompt);
        const cleaned = cleanRawToolCalls(reply?.trim() || 'Done.');
        await saveHistory(sessionId, 'user', prompt);
        await saveHistory(sessionId, 'assistant', cleaned);
        return cleaned;
      } catch (geminiError) {
        log.error('Gemini fallback also failed:', geminiError?.message);
        return 'Both services are temporarily unavailable. Try again in a moment.';
      }
    }
  } catch (error) {
    log.error('Agent error:', error?.message ?? error);
    return 'Something went wrong on my end. Try again.';
  }
}