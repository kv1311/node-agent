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
import {
  createObligation,
  recordSettlement,
  queryObligations,
  updateBalance,
  getObligationDetail,
} from '../tools/obligations.js'

// ── Clients ───────────────────────────────────────────────────────────────────

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY })
const gemini = new GoogleGenerativeAI(process.env.GEMINI_API_KEY)

// ── Background queue ──────────────────────────────────────────────────────────

const jobQueue = []
let processing = false
const pendingReplies = new Map()

function enqueue(name, fn) {
  jobQueue.push({ name, fn })
  if (!processing) processQueue()
}

async function processQueue() {
  if (processing) return
  processing = true
  while (jobQueue.length) {
    const job = jobQueue.shift()
    try {
      log.info(`[QUEUE] Running ${job.name}`)
      await job.fn()
      await new Promise(r => setTimeout(r, 500))
    } catch (err) {
      log.error(`[QUEUE] ${job.name} failed:`, err.message)
    }
  }
  processing = false
}

async function storeDelayedResponse(sessionId, reply) {
  pendingReplies.set(sessionId, reply)
  log.info(`[BACKGROUND] Stored reply for ${sessionId}`)
}

// ── Context cache — keyed by intent ──────────────────────────────────────────

const contextCache = new Map()
const CACHE_TTL = 60_000

async function getCachedContext(prompt, intent) {
  const cacheKey = intent ?? 'general'
  const cached = contextCache.get(cacheKey)
  if (cached && Date.now() - cached.time < CACHE_TTL) return cached.value
  const value = await loadContext(prompt)
  contextCache.set(cacheKey, { value, time: Date.now() })
  return value
}

// ── Tool definitions ──────────────────────────────────────────────────────────

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
}

// ── Intent classifier ─────────────────────────────────────────────────────────

function classifyIntent(prompt) {
  const p = prompt.toLowerCase()

  if (/journal|diary|write.*entry|entry.*write|mood|reflection/i.test(p)) return 'journal'

  // Obligations — catches debt/loan/owe language before generic finance
  if (/\blent\b|\bowed\b|\bowe\b|\bdebt\b|\binstallment\b|\bpay back\b|\bowes me\b|\bowes kv\b|outstanding|remaining|owe.*how much|how much.*owe|who.*owe|owe.*who/i.test(p)) return 'finance'

  if (/spent|paid|expense|₹|\brs\b|transaction|finance|budget|inflow|outflow|credit|debit|kotak|account|balance|invest|slice|transfer/i.test(p)) return 'finance'

  if (/task|todo|to-do|remind|bill|event|watch(list)?|movie|series|show|mark.*done|complete|finish|tick|check off|^done$/i.test(p)) return 'tasks'

  if (/remember|who is|what is|my name|my.*prefer|save.*fact|forget|memory/i.test(p)) return 'memory'

  if (/search|look up|latest|news|current|today.*weather|price of|tell me about|who (is|was)|what (is|was)|explain|describe/i.test(p)) return 'search'

  return 'general'
}

// ── Tool routing ──────────────────────────────────────────────────────────────

function getToolsForIntent(intent) {
  switch (intent) {
    case 'journal':  return TOOL_DEFS.journal
    case 'finance':  return [...TOOL_DEFS.finance, ...TOOL_DEFS.obligations, ...TOOL_DEFS.memory]
    case 'tasks':    return [...TOOL_DEFS.tasks, ...TOOL_DEFS.memory]
    case 'memory':   return TOOL_DEFS.memory
    case 'search':   return TOOL_DEFS.search
    default:         return [...TOOL_DEFS.tasks, ...TOOL_DEFS.memory, ...TOOL_DEFS.search]
  }
}

// ── System prompt ─────────────────────────────────────────────────────────────

function buildSystemPrompt(liveContext, today, minimal = false) {const now = new Date();
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  const tomorrowStr = tomorrow.toISOString().split('T')[0];

  const base = `You are a helpful assistant named Sia that manages tasks, finance, memory, and information for the user.

  Today's date: ${today}. When asked about dates, use this. For reminders, use ISO format: "${today}T13:00:00" for 1pm today, "${tomorrowStr}T09:00:00" for tomorrow 9am.

  Rules:
  - Answer in plain text. No markdown, no JSON, no function names, no XML.
  - If you need to use a tool, do it silently. Never write the tool name or arguments in your response.
  - When the user asks "who am I" or "what is my name", answer with the name they previously told you. If you don't know, say "I don't know your name yet."
  - Do not refer to yourself in third person. Say "I" and "me".
  - Keep responses short and useful. No filler like "Great!" or "Absolutely!".

  Clarification rules (never assume):
  - If any detail needed to complete a request is missing or ambiguous, ask one focused question before acting. Never fill in gaps with guesses.
  - Ask only the single most important missing piece at a time. Do not bombard the user with multiple questions.
  - If the user's intent is unclear, restate what you understood and ask if that is correct before proceeding.
  - For tasks involving money, time, names, or contacts — always confirm the specifics if they are not explicit.

  Learning and memory rules:
  - Pay close attention to how the user phrases things, what they care about, and what they dislike. Adapt over time.
  - If the user corrects you, acknowledge it briefly, update your understanding, and do not repeat the mistake.
  - Notice patterns across conversations — preferred times, recurring tasks, spending habits, priorities — and use them to give smarter suggestions without being asked.
  - If you learn something new and significant about the user (a preference, habit, or fact), remember it and apply it going forward.
  - Never forget a correction or a stated preference the user has given you.

  ${liveContext ? `\nRelevant memory:\n${liveContext}` : ''}`;

  if (minimal) {
    return `You are Sia, a helpful assistant. Today is ${today}. Answer briefly. Never assume missing details — ask instead.\n${liveContext ? `\nMemory:\n${liveContext}` : ''}`;
  }

  return base;
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
      case 'create_obligation':       return await createObligation(args)
      case 'record_settlement':       return await recordSettlement(args)
      case 'query_obligations':       return await queryObligations(args)
      case 'get_obligation_detail':   return await getObligationDetail(args)
      case 'update_balance':          return await updateBalance(args)
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

// ── Gemini — simple messages + fallback ──────────────────────────────────────

async function callGemini(messages, systemPrompt) {
  const model = gemini.getGenerativeModel({
    model: 'gemini-2.5-flash-lite',
    systemInstruction: systemPrompt,
    tools: [{ googleSearch: {} }],
  })

  const conversational = messages.filter(
    m => (m.role === 'user' || m.role === 'assistant') &&
         typeof m.content === 'string' &&
         m.content.trim().length > 0
  )

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
    log.warn('Gemini with history failed, retrying bare')
    const chat = model.startChat({ history: [] })
    const result = await chat.sendMessage(lastMessage?.content ?? '')
    return result.response.text()
  }
}

// ── Groq ──────────────────────────────────────────────────────────────────────

async function callGroq(messages, tools = null) {
  const params = {
    model: tools ? 'llama-3.3-70b-versatile' : 'llama-3.1-8b-instant',
    messages,
    max_tokens: tools ? 1024 : 512,
  }
  if (tools) {
    params.tools = tools
    params.tool_choice = 'auto'
    params.parallel_tool_calls = false  // one tool at a time — more reliable
  }
  return await groq.chat.completions.create(params)
}

async function tryGroqOnly(messages, tools, userPrompt, sessionId) {
  try {
    const response = await callGroq(messages, tools)
    const responseMessage = response.choices[0].message
    
    if (responseMessage.tool_calls) {
      messages.push(responseMessage)
      for (const toolCall of responseMessage.tool_calls) {
        const args = JSON.parse(toolCall.function.arguments)
        const result = await executeTool(toolCall.function.name, args, null)
        messages.push({
          tool_call_id: toolCall.id,
          role: 'tool',
          name: toolCall.function.name,
          content: JSON.stringify(result),
        })
      }
      const final = await groq.chat.completions.create({
        model: 'llama-3.1-8b-instant',
        messages,
        max_tokens: 512,
      })
      let reply = final.choices[0].message.content || 'Done.'
      reply = cleanRawToolCalls(reply)
      await saveHistory(sessionId, 'user', userPrompt)
      await saveHistory(sessionId, 'assistant', reply)
      return cleanRawToolCalls(reply)
    }
    
    let reply = responseMessage.content || '.'
    reply = cleanRawToolCalls(reply)
    await saveHistory(sessionId, 'user', userPrompt)
    await saveHistory(sessionId, 'assistant', reply)
    return cleanRawToolCalls(reply)
  } catch (err) {
    log.error(`Groq-only failed: ${err.message}`)
    return null
  }
}

// ── Background ────────────────────────────────────────────────────────────────

function needsBackground(intent) {
  return ['finance_sync', 'weekly_report', 'memory_enrichment'].includes(intent)
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
  })
  if (!response.ok) throw new Error(`OpenRouter ${response.status}: ${await response.text()}`)
  const data = await response.json()
  return data.choices[0].message.content
}

// ── Main entry point ──────────────────────────────────────────────────────────

function cleanRawToolCalls(text) {
  if (!text) return text
  return text
    .replace(/<function[^>]*>[\s\S]*?<\/function>/gi, '')
    .replace(/<function[^>]*\/>/gi, '')
    .replace(/`?\{"name":\s*"[^"]+",\s*"arguments":\s*\{[^}]*\}\s*\}`?/g, '')
    .replace(/\[function[^\]]*\]/gi, '')
    .replace(/I will (call|use) \w+\([^)]*\)/gi, '')
    .trim()
}

export async function generateResponse(prompt, messageId, sessionId = 'telegram-default') {
  // Helper to scrub raw tool call text from any LLM output
  const cleanRawToolCalls = (text) => {
    if (!text) return text;
    return text
      .replace(/<function[^>]*>[\s\S]*?<\/function>/gi, '')
      .replace(/<function[^>]*\/>/gi, '')
      .replace(/`?\{"name":\s*"[^"]+",\s*"arguments":\s*\{[^}]*\}\s*\}`?/g, '')
      .replace(/\[function[^\]]*\]/gi, '')
      .replace(/I will (call|use) \w+\([^)]*\)/gi, '')
      .trim();
  };

  try {
    const today = new Date().toISOString().split('T')[0];
    const simple = isSimpleMessage(prompt);
    const intent = simple ? 'simple' : classifyIntent(prompt);

    // ── Fast path: mark as done (no LLM needed) ───────────────────────────────
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

    // ── Load history & context ────────────────────────────────────────────────
    const historyLimit = simple ? 2 : (intent === 'general' ? 6 : 3);
    const history = await loadHistory(sessionId, historyLimit);
    const liveContext = simple ? '' : await getCachedContext(prompt, intent);
    const systemPrompt = buildSystemPrompt(liveContext, today, simple);

    const messages = [
      { role: 'system', content: systemPrompt },
      ...history,
      { role: 'user', content: prompt },
    ];

    log.agent(`Session: ${sessionId} | Intent: ${intent} | "${prompt.slice(0, 50)}"`);

    // ── Tool intents: Groq only, no Gemini fallback ──────────────────────────
    const toolIntents = ['memory', 'finance', 'tasks', 'journal'];
    if (toolIntents.includes(intent)) {
      // Force Groq, never fall back to Gemini
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

    // ── Simple messages → Gemini (no tools) ───────────────────────────────────
    if (simple) {
      try {
        const reply = await callGemini(messages, systemPrompt);
        const cleaned = cleanRawToolCalls(reply?.trim() || '.');
        await saveHistory(sessionId, 'user', prompt);
        await saveHistory(sessionId, 'assistant', cleaned);
        return cleaned;
      } catch (geminiErr) {
        log.warn('Gemini simple path failed, falling back to Groq:', geminiErr?.message);
        // fall through to Groq general
      }
    }

    // ── General intent (non‑tool) ──────────────────────────────────────────────
    try {
      const response = await callGroq(messages, null); // no tools
      let reply = response.choices[0].message.content || '.';
      reply = cleanRawToolCalls(reply);
      await saveHistory(sessionId, 'user', prompt);
      await saveHistory(sessionId, 'assistant', reply);
      return reply;
    } catch (groqError) {
      log.warn(`Groq general failed, trying Gemini: ${groqError.message}`);
      // Gemini fallback for general chat
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