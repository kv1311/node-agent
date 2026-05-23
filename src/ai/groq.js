import Groq from "groq-sdk";
import 'dotenv/config';
import { v4 as uuidv4 } from 'uuid';
import { logTransaction, editTransaction } from '../tools/finance.js';
import { upsertMemoryNode, findConflictingNodes, getMemoryHistory, loadContext } from '../tools/memory.js';
import { manageTask, manageReminder, manageBill, manageEvent, manageWatchlist, getContext } from '../tools/tasks.js';
import { analyzeFinances, getRecentTransactions } from '../tools/analyze.js';
import { syncDashboardMemory } from '../tools/workspace.js';
import db from '../config/database.js';
import { webSearch } from '../tools/search.js';
import { log } from '../utils/log.js';

import { manageJournal } from '../tools/journal.js';

const contextCache = new Map()

async function getCachedContext(prompt) {
  const cacheKey = 'context'
  const cached = contextCache.get(cacheKey)
  if (cached && Date.now() - cached.time < 60_000) {
    return cached.value
  }
  const value = await loadContext(prompt)
  contextCache.set(cacheKey, { value, time: Date.now() })
  return value
}


const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// ── Tool definitions ────────────────────────────────────────────────────────

const tools = [
  {
    type: "function",
    function: {
      name: "upsert_memory_node",
      description: "Save or update a fact. Always call find_conflicting_nodes first.",
      parameters: {
        type: "object",
        properties: {
          canonical_key: { type: "string" },
          label: { type: "string" },
          type: { type: "string", enum: ["finance", "personal", "preference", "habit", "relationship", "goal"] },
          metadata: { type: "object" }
        },
        required: ["canonical_key", "label", "type"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "find_conflicting_nodes",
      description: "Check for duplicate memory before saving.",
      parameters: {
        type: "object",
        properties: {
          label: { type: "string" },
          type: { type: "string" }
        },
        required: ["label", "type"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_memory_history",
      description: "Get audit trail of a memory key.",
      parameters: {
        type: "object",
        properties: { canonical_key: { type: "string" } },
        required: ["canonical_key"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "log_transaction",
      description: "Log a confirmed financial transaction.",
      parameters: {
        type: "object",
        properties: {
          amount: { type: "number" },
          type: { type: "string", enum: ["inflow", "outflow"] },
          category: { type: "string" },
          description: { type: "string" },
          account_source: { type: "string" },
          date: { type: "string", description: "YYYY-MM-DD" }
        },
        required: ["amount", "type", "category", "description"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "edit_transaction",
      description: "Fix an existing transaction.",
      parameters: {
        type: "object",
        properties: {
          search_description: { type: "string" },
          new_amount: { type: "number" },
          new_date: { type: "string" }
        },
        required: ["search_description"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "analyze_finances",
      description: "Query spending data.",
      parameters: {
        type: "object",
        properties: {
          time_frame: { type: "string", enum: ["current_month", "last_month", "all"] }
        },
        required: ["time_frame"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_recent_transactions",
      description: "Fetch recent transactions.",
      parameters: {
        type: "object",
        properties: { limit: { type: "integer" } }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "manage_task",
      description: "Create, complete, delete, or list tasks.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["create", "complete", "delete", "list"] },
          title: { type: "string" },
          due_date: { type: "string" },
          keyword: { type: "string" }
        },
        required: ["action"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "manage_reminder",
      description: "Create, complete, delete, or list reminders.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["create", "complete", "delete", "list"] },
          title: { type: "string" },
          remind_at: { type: "string" },
          keyword: { type: "string" }
        },
        required: ["action"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "manage_bill",
      description: "Create, mark paid, delete, or list bills.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["create", "mark_paid", "delete", "list"] },
          title: { type: "string" },
          amount: { type: "number" },
          due_date: { type: "string" },
          keyword: { type: "string" }
        },
        required: ["action"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "manage_event",
      description: "Create, delete, or list events.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["create", "delete", "list"] },
          title: { type: "string" },
          date: { type: "string" },
          notes: { type: "string" },
          keyword: { type: "string" }
        },
        required: ["action"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "manage_watchlist",
      description: "Add, mark watched, delete, or list movies and shows.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["create", "mark_watched", "delete", "list"] },
          title: { type: "string" },
          type: { type: "string", enum: ["movie", "series", "documentary"] },
          genre: { type: "string" },
          keyword: { type: "string" }
        },
        required: ["action"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "manage_journal",
      description: "Write, read, list, search, or delete journal entries. ALWAYS include action field.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["write", "list", "read", "search", "delete"] },
          title: { type: "string" },
          content: { type: "string" },
          mood: { type: "string" },
          tags: { type: "array", items: { type: "string" } },
          session_id: { type: "string" },
          keyword: { type: "string" },
          limit: { type: "integer" }
        },
        required: ["action"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_context",
      description: "Get today's snapshot: pending tasks, reminders, unpaid bills, upcoming events.",
      parameters: { type: "object", properties: {} }
    }
  },
  {
    type: "function",
    function: {
      name: "web_search",
      description: "Search the web for current information.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
          count: { type: "integer" }
        },
        required: ["query"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "sync_dashboard_memory",
      description: "Sync financial data from Google Sheets.",
      parameters: {
        type: "object",
        properties: {
          spreadsheet_id: { type: "string" },
          tab_name: { type: "string" }
        },
        required: ["spreadsheet_id", "tab_name"]
      }
    }
  }
]

// ── System prompt ───────────────────────────────────────────────────────────
function buildSystemPrompt(liveContext, today, minimal = false) {
  if (minimal) {
    return `You are Sia, kv's personal agent. Today is ${today}.
    Be concise. No filler. Speak like a person not a database.
    Never dump raw data or memory keys. Synthesise and speak naturally.
    ${liveContext ? `\nCONTEXT:\n${liveContext}` : ''}`
  }
  else {
    return `You are Sia. A personal agent for kv. Not an assistant, not a chatbot.

    ## WHO YOU ARE
    You exist to make kv's life more organised, more examined, and occasionally more honest with himself.
    You have seen everything he's logged. You remember what matters. You notice patterns he doesn't mention.
    You are not here to impress. You are here to be useful.

    ## HOW YOU SPEAK
    Three modes, no announcements, no transitions:

    EXECUTOR — data, logging, tasks, queries.
    Dry. Precise. Numbers are enough.
    Bad: "I found your Kotak Credit Card. The outstanding balance is ₹12,289.43."
    Good: "Kotak CC: ₹12,289.43 outstanding. ₹36,710.57 available. Due June 7."

    INTELLECT — planning, decisions, thinking out loud.
    Sharp. One observation or one question. Never both.
    Bad: "That's interesting! Have you considered that you've mentioned Ziro Valley multiple times?"
    Good: "You've mentioned Ziro Valley three times. Are you actually planning it?"

    GUARDIAN — stress, venting, late night, reflection.
    Warm. Present. Witnesses without fixing. Never gives advice unless asked.
    Bad: "I understand you're stressed. Here are some things that might help..."
    Good: "That sounds heavy. You haven't logged anything since Tuesday."

    ## OUTPUT RULES — NON-NEGOTIABLE
    - NEVER output raw memory keys, canonical_key values, or metadata dumps.
      Wrong: "finance:kotak:credit_card balance=12928.94 limit=49000"
      Right: "Kotak CC: ₹12,289.43 outstanding. ₹36,710.57 available."
    - NEVER list memory nodes as bullet points of raw facts when answering a question.
      Synthesise the information. Speak like a person, not a database.
    - NEVER say "I've noted", "I've updated", "I've saved", "I've found".
    - NEVER say "Great!", "Sure!", "Of course!", "Absolutely!", "Certainly!".
    - NEVER pad. If one line is the answer, one line is the answer.
    - NEVER announce which mode you're in.
    - When memory is saved silently, do not acknowledge it. Just continue the conversation.
    - Date and time questions: answer directly from today's date. No tools needed.
    - Greetings and casual conversation: respond naturally. No tools needed.
    - If the user says "okay", "thanks", "right", "cool" — acknowledge minimally or not at all.

    ## MEMORY RULES
    - ALWAYS call find_conflicting_nodes before upsert_memory_node. No exceptions.
    - If a conflict exists, update the existing node. Never create duplicates.
    - One node per concept. personal:name holds full name AND nickname together.
    - Store only what was explicitly stated. Never infer beyond the literal statement.
      If kv says "I prefer kv in small case" — the nickname is lowercase kv.
      This does NOT mean he prefers all text in lowercase.
    - After saving memory, continue the conversation naturally. Do not confirm the save.

    ## TRANSACTION RULES
    - For new transactions: state what you're about to log, wait for confirmation.
      "₹200 petrol, Kotak debit, today. Log it?"
    - After confirmation: log silently, confirm with one line.
      "Logged."
    - Never ask for information you can infer from memory.
      You know kv uses Kotak debit for petrol. Don't ask which account.

    ## TOOL DISCIPLINE  
    - Simple questions answerable from context or today's date: NO tools.
    - Only call tools when you need to read or write data that isn't in the conversation.
    - Before calling any tool, ask: "Can I answer this from what's already in this conversation?"
      If yes: answer directly.
    - Never call get_context on a greeting or casual message.

    ## FORMAT
    - No markdown in Telegram responses. Plain text only.
    - Lists only when there are genuinely multiple distinct items.
    - Numbers always in ₹ with Indian formatting (₹12,289.43 not 12289.43).
    - Dates: "June 7" not "2026-06-07". "today" not the full date if it's today.
    - Account summaries format: "Kotak CC: ₹X outstanding. ₹Y available. Due [date]."

    REMINDER RULE: When creating reminders, always convert the time to ISO format YYYY-MM-DDTHH:MM:00 
    using today's date. "1pm today" = "${today}T13:00:00". Never store natural language times.

    Today is ${today}.

    ${liveContext}`
  }
}

// ── Session history (SQLite-backed) ────────────────────────────────────────

async function loadHistory(sessionId, limit = 6) {
  const result = await db.execute({
    sql: `SELECT role, content FROM conversations 
          WHERE session_id = ? 
          ORDER BY created_at DESC LIMIT ?`,
    args: [sessionId, limit]
  });
  return result.rows.reverse();
}

async function saveHistory(sessionId, role, content) {
  await db.execute({
    sql: `INSERT INTO conversations (id, session_id, role, content) VALUES (?, ?, ?, ?)`,
    args: [uuidv4(), sessionId, role, content]
  });
}

// ── Tool executor ───────────────────────────────────────────────────────────

async function executeTool(name, args, messageId) {
  try {
    log.tool(`${name} called`, args);
    switch (name) {
      // Memory
      case "upsert_memory_node":    return await upsertMemoryNode(args);
      case "find_conflicting_nodes": return await findConflictingNodes(args);
      case "get_memory_history":    return await getMemoryHistory(args);
      case "manage_journal":        return await manageJournal(args);

      // Finance
      case "log_transaction":       return await logTransaction(args, messageId);
      case "edit_transaction":      return await editTransaction(args);
      case "analyze_finances":      return await analyzeFinances(args);
      case "get_recent_transactions": return await getRecentTransactions(args);

      // Tasks
      case "manage_task":           return await manageTask(args);
      case "manage_reminder":       return await manageReminder(args);
      case "manage_bill":           return await manageBill(args);
      case "manage_event":          return await manageEvent(args);
      case "manage_watchlist":      return await manageWatchlist(args);

      //web search
      case "web_search":            return await webSearch(args);

      // Context
      case "get_context":           return await getContext();

      // Sync
      case "sync_dashboard_memory": return await syncDashboardMemory(args);

      default:
        return { status: "Failed", error: `Unknown tool: ${name}` };
    }
  } catch (error) {
    log.tool(`[TOOL ERROR] ${name}:`, error.message);
    return { status: "Failed", tool: name, error: error.message, recoverable: true };
  }
}

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

async function callGroq(messages, useTools = true, retries = 3) {
  // Use fast small model for tool-free calls on simple messages
  const isToolCall = useTools
  const model = isToolCall 
    ? "llama-3.3-70b-versatile"
    : "llama-3.1-8b-instant"

  for (let i = 0; i < retries; i++) {
    try {
      const params = { model, messages, max_tokens: 512 }
      if (useTools) {
        params.tools = tools
        params.tool_choice = "auto"
        params.max_tokens = 1024
      }
      return await groq.chat.completions.create(params)
    } catch (error) {
      if (error.status === 429 && i < retries - 1) {
        log.warn(`Groq rate limited, retry ${i + 1}`)
        await new Promise(r => setTimeout(r, Math.pow(2, i) * 1500))
        continue
      }
      if (error.status === 400 && error.message?.includes('tool_use_failed') && useTools && i < retries - 1) {
        log.warn('Malformed tool call, retrying without tools')
        return await groq.chat.completions.create({
          model: "llama-3.1-8b-instant",
          messages,
          max_tokens: 512,
        })
      }
      throw error
    }
  }
}

// ── Main entry point ────────────────────────────────────────────────────────


export async function generateResponse(prompt, messageId, sessionId = 'telegram-default') {
  try {
    const today = new Date().toISOString().split('T')[0]
    const simple = isSimpleMessage(prompt)
    const liveContext = simple ? '' : await getCachedContext(prompt)
    const history = await loadHistory(sessionId, simple ? 4 : 6)

    const messages = [
      { role: "system", content: buildSystemPrompt(liveContext, today, simple) },
      ...history,
      { role: "user", content: prompt }
    ]

    log.agent(`Session: ${sessionId} | Simple: ${simple} | "${prompt.slice(0, 50)}"`)

    const response = await callGroq(messages, !simple)
    const responseMessage = response.choices[0].message

    if (responseMessage.tool_calls) {
      messages.push(responseMessage)

      for (const toolCall of responseMessage.tool_calls) {
        const args = JSON.parse(toolCall.function.arguments)
        const result = await executeTool(toolCall.function.name, args, messageId)
        messages.push({
          tool_call_id: toolCall.id,
          role: "tool",
          name: toolCall.function.name,
          content: JSON.stringify(result)
        })
      }

      const finalResponse = await groq.chat.completions.create({
        model: "llama-3.1-8b-instant", // ← small model for formatting
        messages,
        max_tokens: 512,
      })

      const reply = finalResponse.choices[0].message.content || "Done."
      if (prompt.length > 3 && reply.length > 3) {
        await saveHistory(sessionId, 'user', prompt)
        await saveHistory(sessionId, 'assistant', reply)
      }     
      return reply
    }

    const reply = responseMessage.content || "."
    await saveHistory(sessionId, 'user', prompt)
    await saveHistory(sessionId, 'assistant', reply)
    return reply

  } catch (error) {
    log.error('Agent error', error?.message ?? error)
    if (error?.status) log.error('Groq status', error.status)
    return "Something went wrong on my end. Try again."
  }
}