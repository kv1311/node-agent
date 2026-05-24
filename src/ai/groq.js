import Groq from 'groq-sdk'
import { GoogleGenerativeAI } from '@google/generative-ai'
import 'dotenv/config'
import { v4 as uuidv4 } from 'uuid'
import { logTransaction, editTransaction } from '../tools/finance.js'
import { upsertMemoryNode, findConflictingNodes, getMemoryHistory, loadContext } from '../tools/memory.js'
import { manageTask, manageReminder, manageBill, manageEvent, manageWatchlist, getContext } from '../tools/tasks.js'
import { analyzeFinances, getRecentTransactions } from '../tools/analyze.js'
import { syncDashboardMemory } from '../tools/workspace.js'
import db from '../config/database.js'
import { webSearch } from '../tools/search.js'
import { log } from '../utils/log.js'
import { manageJournal } from '../tools/journal.js'

// Simple in-memory queue and reply storage
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

// ── Clients ───────────────────────────────────────────────────────────────────

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY })
const gemini = new GoogleGenerativeAI(process.env.GEMINI_API_KEY)

// ── Context cache — keyed by INTENT, not single key ──────────────────────────
// Prevents finance questions from getting task-optimised context and vice versa

const contextCache = new Map()
const CACHE_TTL = 60_000 // 60 seconds

async function getCachedContext(prompt, intent) {
  const cacheKey = intent ?? 'general'
  const cached = contextCache.get(cacheKey)
  if (cached && Date.now() - cached.time < CACHE_TTL) return cached.value
  const value = await loadContext(prompt)
  contextCache.set(cacheKey, { value, time: Date.now() })
  return value
}

// ── Tool definitions — grouped by intent ─────────────────────────────────────

const TOOL_DEFS = {
  memory: [
    {
      type: 'function',
      function: {
        name: 'upsert_memory_node',
        description: 'Save or update a fact. Always call find_conflicting_nodes first.',
        parameters: {
          type: 'object',
          properties: {
            canonical_key: { type: 'string' },
            label: { type: 'string' },
            type: { type: 'string', enum: ['finance', 'personal', 'preference', 'habit', 'relationship', 'goal'] },
            metadata: { type: 'object' },
          },
          required: ['canonical_key', 'label', 'type'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'find_conflicting_nodes',
        description: 'Check for duplicate memory before saving.',
        parameters: {
          type: 'object',
          properties: { label: { type: 'string' }, type: { type: 'string' } },
          required: ['label', 'type'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'get_memory_history',
        description: 'Get audit trail of a memory key.',
        parameters: {
          type: 'object',
          properties: { canonical_key: { type: 'string' } },
          required: ['canonical_key'],
        },
      },
    },
  ],

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
        parameters: {
          type: 'object',
          properties: { limit: { type: 'integer' } },
        },
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
}

// ── Intent classifier — zero tokens, pure regex ───────────────────────────────

function classifyIntent(prompt) {
  const p = prompt.toLowerCase();
  
  // Journal
  if (/journal|diary|write.*entry|entry.*write|mood|reflection/i.test(p)) return 'journal';
  
  // Finance
  if (/spent|paid|expense|₹|\brs\b|transaction|finance|budget|inflow|outflow|credit|debit|kotak|account|balance|invest/i.test(p)) return 'finance';
  
  // Tasks – ADDED "mark.*done", "complete", "finish", "tick", "check off", "done"
  if (/task|todo|to-do|remind|bill|event|watch(list)?|movie|series|show|mark.*done|complete|finish|tick|check off|^done$/i.test(p)) return 'tasks';
  
  // Memory
  if (/remember|who is|what is|my name|my.*prefer|save.*fact|forget|memory/i.test(p)) return 'memory';
  
  // Search
  if (/search|look up|latest|news|current|today.*weather|price of/i.test(p)) return 'search';

  // ADD THIS ↓
  if (/tell me about|who (is|was)|what (is|was)|explain|describe/i.test(p)) return 'search'
  
  return 'general';
}

function getToolsForIntent(intent) {
  switch (intent) {
    case 'journal':  return TOOL_DEFS.journal
    case 'finance':  return [...TOOL_DEFS.finance, ...TOOL_DEFS.memory]
    case 'tasks':    return [...TOOL_DEFS.tasks, ...TOOL_DEFS.memory]
    case 'memory':   return TOOL_DEFS.memory
    case 'search':   return TOOL_DEFS.search
    default:         return [...TOOL_DEFS.tasks, ...TOOL_DEFS.memory, ...TOOL_DEFS.search]
  }
}

// ── System prompt — rules only, no examples ───────────────────────────────────

function buildSystemPrompt(liveContext, today, minimal = false, intent = 'general') {
  const now = new Date()
  const tomorrowDate = new Date(now)
  tomorrowDate.setDate(now.getDate() + 1)
  const tomorrow = tomorrowDate.toISOString().split('T')[0]

  // Timezone
  const offsetMinutes = -now.getTimezoneOffset()
  const offsetHours = Math.floor(Math.abs(offsetMinutes) / 60)
  const offsetMins = Math.abs(offsetMinutes) % 60
  const offsetSign = offsetMinutes >= 0 ? '+' : '-'
  const userTimezone = `${offsetSign}${String(offsetHours).padStart(2, '0')}:${String(offsetMins).padStart(2, '0')}`

  if (minimal) {
    return `You are Sia, kv's personal agent. Today is ${today}.
Be conversational. Answer naturally. No filler.
${liveContext ? `\nCONTEXT:\n${liveContext}` : ''}`
  }

  return `You are Sia — kv's personal agent. Not a chatbot. Today is ${today}.

PERSONA: Loyal, sharp, warm when needed. Three modes (never announced):
- EXECUTOR (data/tasks/finance): dry, precise. "Kotak CC: ₹12,289 outstanding. Due June 7."
- INTELLECT (planning/decisions): one sharp observation OR one question, never both.
- GUARDIAN (stress/venting/late night): warm, present, witnesses without fixing.

OUTPUT RULES:
- Never dump raw memory keys, canonical_key values, or metadata.
- Never say "I've noted/updated/saved/found" or "Great!/Sure!/Absolutely!".
- Never pad. One line answer = one line response.
- No markdown in Telegram. Plain text only.
- Numbers: ₹ with Indian formatting. Dates: "June 7" not "2026-06-07".
- When confirming tool actions, be specific: "Logged: ₹215 ice cream + milk, Kotak."

MEMORY RULES:
- Always call find_conflicting_nodes before upsert_memory_node.
- One node per concept. Never create duplicates.
- After saving, continue naturally — do not confirm the save.

TRANSACTION RULES:
- State what you'll log, wait for confirmation. Then log and confirm specifically.
- Never ask for info you can infer from memory.

TOOL DISCIPLINE:
- Simple questions answerable from context: NO tools.
- Never call get_context on greetings or casual messages.

REMINDER RULE: Always store times as ISO 8601: "1pm today" = "${today}T13:00:00${userTimezone}". "tomorrow 9am" = "${tomorrow}T09:00:00${userTimezone}".

${liveContext}`
}

// ── History ───────────────────────────────────────────────────────────────────

async function loadHistory(sessionId, limit = 6) {
  const result = await db.execute({
    sql: `SELECT role, content FROM conversations
          WHERE session_id = ?
          ORDER BY created_at DESC LIMIT ?`,
    args: [sessionId, limit],
  })
  return result.rows.reverse()
}

async function saveHistory(sessionId, role, content) {
  await db.execute({
    sql: `INSERT INTO conversations (id, session_id, role, content) VALUES (?, ?, ?, ?)`,
    args: [uuidv4(), sessionId, role, content],
  })
}

// ── Tool executor ─────────────────────────────────────────────────────────────

async function executeTool(name, args, messageId) {
  try {
    log.tool(`${name} called`, args)
    switch (name) {
      case 'upsert_memory_node':      return await upsertMemoryNode(args)
      case 'find_conflicting_nodes':  return await findConflictingNodes(args)
      case 'get_memory_history':      return await getMemoryHistory(args)
      case 'manage_journal':          return await manageJournal(args)
      case 'log_transaction':         return await logTransaction(args, messageId)
      case 'edit_transaction':        return await editTransaction(args)
      case 'analyze_finances':        return await analyzeFinances(args)
      case 'get_recent_transactions': return await getRecentTransactions(args)
      case 'manage_task':             return await manageTask(args)
      case 'manage_reminder':         return await manageReminder(args)
      case 'manage_bill':             return await manageBill(args)
      case 'manage_event':            return await manageEvent(args)
      case 'manage_watchlist':        return await manageWatchlist(args)
      case 'web_search':              return await webSearch(args)
      case 'get_context':             return await getContext()
      case 'sync_dashboard_memory':   return await syncDashboardMemory(args)
      default:
        return { status: 'Failed', error: `Unknown tool: ${name}` }
    }
  } catch (error) {
    log.tool(`[TOOL ERROR] ${name}:`, error.message)
    return { status: 'Failed', tool: name, error: error.message, recoverable: true }
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
  ]
  return simple.some(r => r.test(prompt.trim()))
}

// ── Gemini call — used for simple messages AND as Groq fallback ───────────────

async function callGemini(messages, systemPrompt) {
  const model = gemini.getGenerativeModel({
    model: 'gemini-2.5-flash-lite',         // updated model string
    systemInstruction: systemPrompt,
    tools: [{ googleSearch: {} }],  
  })

  // Filter to user/assistant only — Gemini rejects system + tool messages
  const conversational = messages.filter(
    m => (m.role === 'user' || m.role === 'assistant') &&
         typeof m.content === 'string' &&
         m.content.trim().length > 0
  )

  // Gemini requires history to start with user role
  while (conversational.length > 0 && conversational[0].role === 'assistant') {
    conversational.shift()
  }

  const lastMessage = conversational[conversational.length - 1]
  const priorMessages = conversational.slice(0, -1)

  const geminiHistory = priorMessages.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }))

  try {
    const chat = model.startChat({ history: geminiHistory })
    const result = await chat.sendMessage(lastMessage?.content ?? '')
    return result.response.text()
  } catch {
    // If history causes issues, bare call with no history
    log.warn('Gemini with history failed, retrying bare')
    const chat = model.startChat({ history: [] })
    const result = await chat.sendMessage(lastMessage?.content ?? '')
    return result.response.text()
  }
}

// ── Groq call — throws immediately on error, no retry ────────────────────────

async function callGroq(messages, tools = null) {
  const params = {
    model: tools ? 'llama-3.3-70b-versatile' : 'llama-3.1-8b-instant',
    messages,
    max_tokens: tools ? 1024 : 512,
  }
  if (tools) {
    params.tools = tools
    params.tool_choice = 'auto'
    params.response_format = { type: 'text' }  
  }
  return await groq.chat.completions.create(params)
}
// ── Background decision ─────────────────────────────────────────────
function needsBackground(prompt, intent) {
  // Tasks that can wait (e.g., long analysis, syncs, weekly reports)
  const backgroundIntents = ['finance_sync', 'weekly_report', 'memory_enrichment'];
  return backgroundIntents.includes(intent);
}

// Simple in-memory storage for delayed replies (or use DB)
async function storeDelayedResponse(sessionId, reply) {
  pendingReplies.set(sessionId, reply);
  // Optional: send via webhook later – for now just store
  console.log(`[BACKGROUND] Stored reply for ${sessionId}`);
}

// ── OpenRouter free model (Nemotron) ───────────────────────────────
async function callOpenRouterFree(messages, systemPrompt) {
  const MODEL_ID = 'nvidia/nemotron-3-nano-30b-a3b:free';
  const formattedMessages = [
    { role: 'system', content: systemPrompt },
    ...messages.filter(m => m.role !== 'system')
  ];

  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL_ID,
      messages: formattedMessages,
      max_tokens: 1024,
      temperature: 0.7,
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`OpenRouter error ${response.status}: ${err}`);
  }
  const data = await response.json();
  return data.choices[0].message.content;
}

// ── Main entry point ──────────────────────────────────────────────────────────

export async function generateResponse(prompt, messageId, sessionId = 'telegram-default') {
  try {
    const today = new Date().toISOString().split('T')[0];
    const simple = isSimpleMessage(prompt);
    const intent = simple ? 'simple' : classifyIntent(prompt);


    // ── Optimized "Mark as Done" Shortcut ────────────────────────────────────────
// Captures variations like: mark 'buy milk' as done, complete buy milk, tick gym, check off laundry
const markMatch = prompt.match(/^(?:mark\s+['"]?(.+?)['"]?\s+as\s+done|complete\s+['"]?(.+?)['"]?|tick\s+['"]?(.+?)['"]?|check\s+off\s+['"]?(.+?)['"]?)$/i);

if (markMatch) {
  // Extract whichever capture group caught the title string
  const title = (markMatch[1] || markMatch[2] || markMatch[3] || markMatch[4])?.trim();
  let updated = false;

  if (title) {
    // Try updating tasks table first
    let result = await db.execute({
      sql: `UPDATE tasks SET done = 1 WHERE title LIKE ? AND done = 0`,
      args: [`%${title}%`]
    });
    
    // Check both standard wrapper property variations for affected rows
    if ((result.rowsAffected ?? result.affectedRows ?? 0) > 0) {
      updated = true;
    }

    // If no task matched, try updating reminders table
    if (!updated) {
      result = await db.execute({
        sql: `UPDATE reminders SET done = 1 WHERE title LIKE ? AND done = 0`,
        args: [`%${title}%`]
      });
      if ((result.rowsAffected ?? result.affectedRows ?? 0) > 0) {
        updated = true;
      }
    }

    const reply = updated ? `✓ Marked "${title}" as done.` : `No pending task or reminder matched "${title}".`;
    await saveHistory(sessionId, 'user', prompt);
    await saveHistory(sessionId, 'assistant', reply);
    return reply;
  }
}
    
    // ── BACKGROUND PATH: for slow, non-interactive tasks ──────────────
    if (!simple && needsBackground(prompt, intent)) {
      // We need messages and systemPrompt – build them first
      const historyLimit = 3; // shorter history for background
      const history = await loadHistory(sessionId, historyLimit);
      const liveContext = await getCachedContext(prompt, intent);
      const systemPromptBg = buildSystemPrompt(liveContext, today, false,intent);
      const messagesBg = [
        { role: 'system', content: systemPromptBg },
        ...history,
        { role: 'user', content: prompt },
      ];

      enqueue(`${sessionId}-${Date.now()}`, async () => {
        try {
          const reply = await callOpenRouterFree(messagesBg, systemPromptBg);
          await saveHistory(sessionId, 'assistant', reply);
          await storeDelayedResponse(sessionId, reply);
          // Optionally send via Telegram webhook if you have bot instance
        } catch (err) {
          log.error(`Background job failed: ${err.message}`);
        }
      });
      return "🔄 I'm working on that in the background. I'll notify you when it's ready.";
    }

    // ── NORMAL PATH: determine history length ────────────────────────
    const historyLimit = simple ? 2 : (intent === 'general' ? 6 : 3);
    const history = await loadHistory(sessionId, historyLimit);
    const liveContext = simple ? '' : await getCachedContext(prompt, intent);
    const systemPrompt = buildSystemPrompt(liveContext, today, simple, intent);

    const messages = [
      { role: 'system', content: systemPrompt },
      ...history,
      { role: 'user', content: prompt },
    ];

    log.agent(`Session: ${sessionId} | Intent: ${intent} | "${prompt.slice(0, 50)}"`);

    // ── SIMPLE MESSAGES → Gemini (fast, cheap) ────────────────────────
    if (simple) {
      try {
        log.warn(`Calling Gemini for simple message in session ${sessionId}`);
        const reply = await callGemini(messages, systemPrompt);
        const cleaned = reply?.trim() || '.';
        await saveHistory(sessionId, 'user', prompt);
        await saveHistory(sessionId, 'assistant', cleaned);
        return cleaned;
      } catch (geminiErr) {
        log.warn('Gemini simple path failed, falling back to Groq:', geminiErr?.message);
      }
    }


    
    // ── TOOL INTENTS or fallback from Nemotron → Groq ─────────────────
    try {
      const selectedTools = getToolsForIntent(intent);
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
        const reply = finalResponse.choices[0].message.content || 'Done.';
        if (prompt.length > 3 && reply.length > 3) {
          await saveHistory(sessionId, 'user', prompt);
          await saveHistory(sessionId, 'assistant', reply);
        }
        return reply;
      }

      let reply = responseMessage.content || '.'

      if (reply.trim().startsWith('{') && reply.includes('"function"')) {
        const rephrase = await groq.chat.completions.create({
          model: 'llama-3.1-8b-instant',
          messages: [
            { role: 'system', content: buildSystemPrompt('', today, true) },
            { role: 'user', content: prompt },
            { role: 'assistant', content: 'I need to process this request.' },
            { role: 'user', content: 'Please respond in plain conversational text only. No JSON.' }
          ],
          max_tokens: 256,
        })
        reply = rephrase.choices[0].message.content || '.'
      }
      await saveHistory(sessionId, 'user', prompt);
      await saveHistory(sessionId, 'assistant', reply);
      return reply;

    } catch (groqError) {
  const isTransient = groqError?.status === 429 || groqError?.status >= 500;
  const isToolFailure = groqError?.message?.includes('tool_use_failed');
  if (!isTransient && !isToolFailure) {
    log.error('Groq non-retriable error:', groqError?.message);
    return 'Something went wrong on my end. Try again.';
  }
  log.warn(`Groq failed (${groqError?.status}) — trying Gemini`);
  // Then proceed to Gemini fallback
}

    // ── FINAL FALLBACK: Gemini ────────────────────────────────────────
    try {
      await new Promise(r => setTimeout(r, 500));
      console.log(`[FALLBACK] Calling Gemini for session ${sessionId}`);
      const reply = await callGemini(messages, systemPrompt);
      const cleaned = reply?.trim() || 'Done.';
      await saveHistory(sessionId, 'user', prompt);
      await saveHistory(sessionId, 'assistant', cleaned);
      return cleaned;
    } catch (geminiError) {
      log.error('Gemini fallback also failed:', geminiError?.message);
      return 'Both services are temporarily unavailable. Try again in a moment.';
    }

  } catch (error) {
    log.error('Agent error:', error?.message ?? error);
    return 'Something went wrong on my end. Try again.';
  }
}