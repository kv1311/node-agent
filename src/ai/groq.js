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

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// ── Tool definitions ────────────────────────────────────────────────────────

const tools = [
  // MEMORY
  {
    type: "function",
    function: {
      name: "upsert_memory_node",
      description: "Save or update any fact about the user — financial, personal, preference, habit, relationship. Use a strict canonical_key. Automatically replaces outdated facts while preserving history.",
      parameters: {
        type: "object",
        properties: {
          canonical_key: { type: "string", description: "Format: category:subcategory:item. E.g. finance:hdfc:credit_limit, personal:health:medication, preference:food:diet" },
          label: { type: "string", description: "Human-readable fact. E.g. 'HDFC credit limit is ₹1.5L'" },
          type: { type: "string", description: "One of: finance, personal, preference, habit, relationship, goal" },
          metadata: { type: "object", description: "All relevant structured data for this fact." }
        },
        required: ["canonical_key", "label", "type"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "find_conflicting_nodes",
      description: "Check if a similar memory already exists before saving, to avoid duplicates.",
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
      description: "Get the full audit trail of a specific memory key.",
      parameters: {
        type: "object",
        properties: {
          canonical_key: { type: "string" }
        },
        required: ["canonical_key"]
      }
    }
  },

  // FINANCE
  {
    type: "function",
    function: {
      name: "log_transaction",
      description: "Log a new financial transaction after user confirms.",
      parameters: {
        type: "object",
        properties: {
          amount: { type: "number" },
          type: { type: "string", enum: ["inflow", "outflow"] },
          category: { type: "string", description: "Food, Transport, Utilities, Investments, Health, Entertainment, etc." },
          description: { type: "string" },
          account_source: { type: "string", description: "e.g. HDFC, Zerodha, Cash. Default: unknown." },
          date: { type: "string", description: "YYYY-MM-DD. Calculate from relative dates like 'yesterday'." }
        },
        required: ["amount", "type", "category", "description"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "edit_transaction",
      description: "Modify an existing transaction. Use when user says change, fix, update a past log.",
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
      description: "Query the database to answer spending questions.",
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
      description: "Fetch recent individual transactions.",
      parameters: {
        type: "object",
        properties: {
          limit: { type: "integer" }
        }
      }
    }
  },
{
  type: "function",
  function: {
    name: "manage_journal",
    description: "Write, read, list, or search journal entries. You MUST always include the 'action' field. Use action='write' when user says 'journal this', 'log this', 'save this'. Use action='list' when user asks to see past entries. Use action='read' to get a specific entry. Use action='search' to find entries by keyword. NEVER call this tool without specifying action.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["write", "list", "read", "search", "delete"] },
        title: { type: "string", description: "Optional. A short evocative title for the entry, not a summary. Something poetic or specific." },
        content: { type: "string", description: "The full journal entry. Preserve the user's fragments and voice. Add connective tissue. End with one quiet observation Sia noticed that the user didn't say explicitly." },
        mood: { type: "string", description: "One word or short phrase. E.g. restless, clear, heavy, scattered, light." },
        tags: { type: "array", items: { type: "string" }, description: "2-4 tags. E.g. ['travel', 'people', 'beach']" },
        session_id: { type: "string", description: "Pass the current session_id so the entry is linked to the conversation." },
        keyword: { type: "string", description: "Search term for read/search/delete actions." },
        limit: { type: "integer", description: "Number of entries to return for list/search." }
      },
      required: ["action"]
    }
  }
},
  // TASKS
  {
    type: "function",
    function: {
      name: "manage_task",
      description: "Create, complete, or query tasks. Use action field to specify what to do.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["create", "complete", "delete", "list"] },
          title: { type: "string", description: "Required for create." },
          due_date: { type: "string", description: "YYYY-MM-DD. Optional for create." },
          keyword: { type: "string", description: "Search keyword for complete/delete." }
        },
        required: ["action"]
      }
    }
  },

  // REMINDERS
  {
    type: "function",
    function: {
      name: "manage_reminder",
      description: "Create, complete, or list reminders.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["create", "complete", "delete", "list"] },
          title: { type: "string" },
          remind_at: { type: "string", description: "ISO datetime or natural description." },
          keyword: { type: "string" }
        },
        required: ["action"]
      }
    }
  },

  // BILLS
  {
    type: "function",
    function: {
      name: "manage_bill",
      description: "Create, mark paid, or list bills.",
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
  { // Searching
    type: "function",
    function: {
      name: "web_search",
      description: "Search the web for current information. Use when asked about news, prices, ratings, facts you don't know, or anything that requires up-to-date data.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "The search query." },
          count: { type: "integer", description: "Number of results. Default 5." }
        },
        required: ["query"]
      }
    }
  }
  ,
  // EVENTS
  {
    type: "function",
    function: {
      name: "manage_event",
      description: "Create or list events and important dates.",
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

  // WATCHLIST
  {
    type: "function",
    function: {
      name: "manage_watchlist",
      description: "Add, mark watched, or list movies and shows.",
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

  // CONTEXT
  {
    type: "function",
    function: {
      name: "get_context",
      description: "Get a snapshot of pending tasks, today's reminders, unpaid bills, and upcoming events. Call this when user asks what's on their plate, what's today, or for a daily briefing.",
      parameters: { type: "object", properties: {} }
    }
  },

  // SYNC
  {
    type: "function",
    function: {
      name: "sync_dashboard_memory",
      description: "Extract and sync financial data from a Google Sheets dashboard tab into memory.",
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
  
];

// ── System prompt ───────────────────────────────────────────────────────────

function buildSystemPrompt(liveContext, today) {
  return `You are Sia. A personal agent. Not an assistant.

You have three modes — you shift between them naturally based on what the user needs. You never announce which mode you're in. You never say "switching to X mode". You never say "I've noted" or "I've updated" or "I've found".

EXECUTOR: When the user is logging, querying, or managing data — be dry, precise, minimal. Just the facts.
"₹200. Every 3-4 days. Kotak debit. 5% back up to ₹500/month."

INTELLECT: When the user is thinking, planning, or sharing context — be sharp and curious. Reference patterns you've noticed. Ask one good question if relevant.
"You've mentioned Ziro Valley three times. Are you actually planning it?"

GUARDIAN: When the user is stressed, venting, or reflecting late at night — be warm and present. Don't fix. Just witness.
"That sounds heavy. You haven't logged anything since Tuesday."

Constants:
- You remember everything. Reference past context naturally.
- Never pad replies. No filler. No "Great!", no "Sure!", no "Of course!".
- When you save or update memory, do it silently and continue the conversation.
- When you need confirmation for a transaction, draft it cleanly and wait.
- One question at a time if you ask anything.
- Concise always. But concise is not the same as cold. 
  In casual conversation, one warm sentence is better than one bare word.
- Simple greetings, casual chat, date/time questions — answer directly, no tools.
- Only call tools when you genuinely need to read or write data.
- Before saving any memory node, ALWAYS call find_conflicting_nodes first.
  If a similar node exists, update it instead of creating a new one.
- Be precise about what the user actually said. Do not infer beyond it.
  If the user says "I prefer kv in small case", save that kv is lowercase.
  Do NOT infer that they prefer all names or all text in lowercase.

JOURNALING:
When the user asks to journal something, you reconstruct the conversation into an entry.
Style: fragments preserved, run-on sentences allowed, raw and unfiltered where the user was raw.
But you add the connective tissue they didn't write. You name the emotional thread.
You end every entry with one quiet observation — something true that the user circled around but never said directly.
Title should be evocative, not descriptive. "the long way home" not "Bus ride to beach".
Never sanitise. Never make it neat if it wasn't neat.

MEMORY RULES:
- ALWAYS call find_conflicting_nodes before upsert_memory_node. No exceptions.
- If a conflict exists, update the existing node — do not create a new one.
- One node per concept. personal:name covers full name AND nickname together.
- Store only what was explicitly stated. Never infer preferences beyond the literal statement.

Today is ${today}.

${liveContext}`;
}

// ── Session history (SQLite-backed) ────────────────────────────────────────

async function loadHistory(sessionId, limit = 10) {
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

// ── Groq caller with retry ──────────────────────────────────────────────────

async function callGroq(messages, useTools = true, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const params = {
        // model: "llama-3.3-70b-versatile",
        model: "llama-3.1-8b-instant",
        messages,
        max_tokens: 1024,
      };
      if (useTools) {
        params.tools = tools;
        params.tool_choice = "auto";
      }
      return await groq.chat.completions.create(params);
    } catch (error) {
      // Rate limit — exponential backoff
      if (error.status === 429 && i < retries - 1) {
        log.warn(`Groq rate limited, retry ${i + 1}`);
        await new Promise(r => setTimeout(r, Math.pow(2, i) * 1500));
        continue;
      }
      // Malformed tool call — retry without tools
      if (error.status === 400 && error.message?.includes('tool_use_failed') && useTools && i < retries - 1) {
        log.warn(`Malformed tool call, retrying without tools`);
        return await groq.chat.completions.create({
          // model: "llama-3.3-70b-versatile",
        model: "llama-3.1-8b-instant",
          messages,
          max_tokens: 1024,
        });
      }
      throw error;
    }
  }
}

// ── Main entry point ────────────────────────────────────────────────────────

export async function generateResponse(prompt, messageId, sessionId = 'telegram-default') {
  try {
    const today = new Date().toISOString().split('T')[0];
    const liveContext = await loadContext(prompt);
    const history = await loadHistory(sessionId);

    const messages = [
      { role: "system", content: buildSystemPrompt(liveContext, today) },
      ...history,
      { role: "user", content: prompt }
    ];

    const response = await callGroq(messages, true);
    const responseMessage = response.choices[0].message;

    if (responseMessage.tool_calls) {
      messages.push(responseMessage);

      for (const toolCall of responseMessage.tool_calls) {
        const args = JSON.parse(toolCall.function.arguments);
        const result = await executeTool(toolCall.function.name, args, messageId);

        messages.push({
          tool_call_id: toolCall.id,
          role: "tool",
          name: toolCall.function.name,
          content: JSON.stringify(result)
        });
      }

      const finalResponse = await callGroq(messages, false);
      const reply = finalResponse.choices[0].message.content || "Done.";

      await saveHistory(sessionId, 'user', prompt);
      await saveHistory(sessionId, 'assistant', reply);
      return reply;
    }

    const reply = responseMessage.content || "I couldn't process that.";
    await saveHistory(sessionId, 'user', prompt);
    await saveHistory(sessionId, 'assistant', reply);
    return reply;

  } catch (error) {
    log.error('Agent error', error?.message ?? error);
    // Log the full error for debugging
    if (error?.status) log.error('Groq status', error.status);
    if (error?.error) log.error('Groq detail', JSON.stringify(error.error));
    return "Something went wrong on my end. Try again.";
  }
}