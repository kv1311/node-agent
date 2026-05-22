import Groq from "groq-sdk";
import 'dotenv/config';
import { logTransaction, editTransaction } from '../tools/finance.js';
import { upsertMemoryNode, fetchMemories, findConflictingNodes, getMemoryHistory } from '../tools/memory.js';

import { analyzeFinances, getRecentTransactions } from '../tools/analyze.js';
import { ingestGoogleSheet } from '../tools/workspace.js';

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const conversationHistory = [];
const MAX_HISTORY = 10; // Keeps the last 5 turns (user + assistant)

const tools = [
    {
        type: "function",
        function: {
            name: "upsert_memory_node",
            description: "Save or update a memory fact. Use a strict canonical_key. Automatically replaces outdated facts.",
            parameters: {
                type: "object",
                properties: {
                    canonical_key: { type: "string", description: "Format 'category:specific_item' (e.g., 'finance:hdfc_cc_limit', 'finance:uncle_investment_target')" },
                    label: { type: "string", description: "The human-readable fact (e.g., 'HDFC Credit Card Limit is 1.5 Lakhs')" },
                    type: { type: "string", description: "Must be 'finance', 'preference', or 'personal'" },
                    metadata: { type: "object", description: "Optional key-value details." }
                },
                required: ["canonical_key", "label", "type"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "logTransaction",
            description: "Logs a NEW financial transaction.",
            parameters: {
                type: "object",
                properties: {
                    amount: { type: "number", description: "Amount. MUST be a raw JSON number, not a string." },
                    type: { type: "string", enum: ["inflow", "outflow"], description: "Exactly 'outflow' or 'inflow'." },
                    category: { type: "string", description: "E.g., Food, Utilities, Investments, Tech." },
                    description: { type: "string", description: "Short description (e.g., 'HDFC bill')." },
                    owner: { type: "string", description: "Defaults to 'personal', but set to a specific name if the user mentions tracking funds for someone else." },
                    account_source: { type: "string", description: "e.g., 'HDFC', 'Zerodha'. Default: 'unknown'." },
                    date: { type: "string", description: "Optional. YYYY-MM-DD. Calculate this if user says 'yesterday'." }
                },
                required: ["amount", "type", "category", "description"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "editTransaction",
            description: "Modifies an EXISTING transaction in the database. Use this if the user says 'change', 'update', or 'fix' an old log.",
            parameters: {
                type: "object",
                properties: {
                    search_description: { type: "string", description: "A keyword to find the old transaction (e.g., 'HDFC')." },
                    new_amount: { type: "number", description: "The corrected amount. Raw JSON number." },
                    new_date: { type: "string", description: "The corrected date in YYYY-MM-DD format." }
                },
                required: ["search_description"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "analyzeFinances",
            description: "Queries the SQLite database to answer questions about past spending.",
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
            name: "getRecentTransactions",
            description: "Fetches a list of the most recent individual transactions from the database.",
            parameters: {
                type: "object",
                properties: {
                    limit: { type: "integer", description: "How many transactions to retrieve (default 10)." }
                }
            }
        }
    },
    {
        type: "function",
        function: {
            name: "findConflictingNodes",
            description: "Check if a similar memory already exists in the graph before saving to avoid duplicate concepts.",
            parameters: {
                type: "object",
                properties: {
                    label: { type: "string", description: "The concept you are checking for (e.g., 'HDFC')" },
                    type: { type: "string", description: "The category (e.g., 'finance')" }
                },
                required: ["label", "type"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "ingestGoogleSheet",
            description: "Extracts all tabs and rows from a Google Sheet and migrates them into the SQLite financial database.",
            parameters: {
                type: "object",
                properties: {
                    spreadsheet_id: { type: "string", description: "The Google Sheet ID extracted from the URL." }
                },
                required: ["spreadsheet_id"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "getMemoryHistory",
            description: "Get the complete audit trail and past versions of a specific memory key.",
            parameters: {
                type: "object",
                properties: {
                    canonical_key: { type: "string", description: "The exact key to look up (e.g., 'finance:hdfc_cc_limit')" }
                },
                required: ["canonical_key"]
            }
        }
    }
];

export async function generateResponse(prompt, messageId) {
    try {
        const activeMemories = await fetchMemories();
        const memoryContext = activeMemories.join(' | ');
        const today = new Date();
        const todayISO = today.toISOString().split('T')[0];

        // 2. INJECT HISTORY INTO THE MESSAGES
        const messages = [
            { 
                role: "system", 
                content: `You are the personal assistant for Kamalavasanthan. 
                Today's date is: ${todayISO}. 
                
                LONG TERM MEMORY FACTS: [ ${memoryContext} ]
                
                CRITICAL RULES:
                1. CALL ONLY ONE TOOL AT A TIME. 
                2. THE CONFIRMATION LOOP: Draft new transactions and ask for confirmation first. ONLY execute 'logTransaction' AFTER the user says yes.
                3. If the user wants to correct a past mistake, use editTransaction.
                4. NEVER output raw <function=...> tags in your text.
                5. THE MEMORY WORKFLOW: When saving a new fact, use 'findConflictingNodes' first, then 'upsert_memory_node'.
                6. GOOGLE SHEETS: You have secure backend access to Google Workspace. If the user provides a Google Sheets URL and asks to migrate or read it, DO NOT say you lack access. Extract the Spreadsheet ID from the URL and immediately call the 'ingestGoogleSheet' tool.`
                   
            },
            ...conversationHistory,
            { role: "user", content: prompt }
        ];

        const response = await groq.chat.completions.create({
            model: "llama-3.3-70b-versatile",
            messages: messages,
            tools: tools,
            tool_choice: "auto"
        });

        const responseMessage = response.choices[0].message;

        if (responseMessage.tool_calls) {
            // ... exact same tool execution loop ...
            messages.push(responseMessage);

            for (const toolCall of responseMessage.tool_calls) {
                const args = JSON.parse(toolCall.function.arguments);
                let apiResponse;
                
                if (toolCall.function.name === "logTransaction") apiResponse = await logTransaction(args, messageId);
                else if (toolCall.function.name === "analyzeFinances") apiResponse = await analyzeFinances(args);
                else if (toolCall.function.name === "editTransaction") apiResponse = await editTransaction(args);
                else if (toolCall.function.name === "upsert_memory_node") apiResponse = await upsertMemoryNode(args);
                else if (toolCall.function.name === "findConflictingNodes") apiResponse = await findConflictingNodes(args);
                else if (toolCall.function.name === "getMemoryHistory") apiResponse = await getMemoryHistory(args);
                else if (toolCall.function.name === "ingestGoogleSheet") apiResponse = await ingestGoogleSheet(args);
                else if (toolCall.function.name === "getRecentTransactions") apiResponse = await getRecentTransactions(args);
                messages.push({
                    tool_call_id: toolCall.id,
                    role: "tool",
                    name: toolCall.function.name,
                    content: JSON.stringify(apiResponse)
                });
            }

            const finalResponse = await groq.chat.completions.create({
                model: "llama-3.3-70b-versatile",
                messages: messages
            });

            // 3. SAVE THE INTERACTION TO HISTORY
            conversationHistory.push({ role: "user", content: prompt });
            conversationHistory.push({ role: "assistant", content: finalResponse.choices[0].message.content });
            if (conversationHistory.length > MAX_HISTORY) conversationHistory.splice(0, 2);

            return finalResponse.choices[0].message.content || "✅ Task completed.";
        }

        // 3. SAVE THE INTERACTION TO HISTORY (If no tools were used)
        conversationHistory.push({ role: "user", content: prompt });
        conversationHistory.push({ role: "assistant", content: responseMessage.content });
        if (conversationHistory.length > MAX_HISTORY) conversationHistory.splice(0, 2);

        return responseMessage.content || "I couldn't process that.";
    } catch (error) {
        console.error("API Error:", error.message);
        return "Sorry, my brain encountered an error.";
    }
}