import Groq from "groq-sdk";
import fs from 'fs';
import 'dotenv/config';
import { logTransaction } from '../tools/finance.js';
import { analyzeFinances } from '../tools/analyze.js';

const userProfile = JSON.parse(fs.readFileSync('./profile.json', 'utf8'));
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// Groq/OpenAI requires standard JSON Schema for tools
const tools = [
    {
        type: "function",
        function: {
            name: "logTransaction",
            description: `Logs a financial transaction. Use this whenever the user spends or invests. If the user mentions investing ${userProfile.currency}${userProfile.investment_pools.uncle.target_monthly} for their Uncle, strictly set the 'owner' parameter to 'uncle'.`,
            parameters: {
                type: "object",
                properties: {
                    amount: { type: "number", description: `Amount in ${userProfile.currency}.` },
                    type: { type: "string", enum: ["inflow", "outflow"], description: "Exactly 'outflow' or 'inflow'." },
                    category: { type: "string", description: `Must be one of: ${userProfile.custom_categories.join(', ')}` },
                    description: { type: "string", description: "Short description (e.g., 'Family dinner')." },
                    owner: { type: "string", description: "Defaults to 'personal', but set to 'uncle' if tracking his funds." },
                    account_source: { type: "string", description: "e.g., 'HDFC', 'Zerodha'. Default: 'unknown'." }
                },
                required: ["amount", "type", "category", "description"]
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
                    time_frame: { type: "string", enum: ["current_month", "last_month", "all"], description: "Time frame to filter." },
                    type_filter: { type: "string", enum: ["inflow", "outflow", "all"], description: "Type of transaction." }
                },
                required: ["time_frame"]
            }
        }
    }
];

export async function generateResponse(prompt, messageId) {
    try {
        const messages = [
            { role: "system", content: `You are the personal assistant for ${userProfile.name}. You must use tools to log or retrieve data. Never make up numbers.` },
            { role: "user", content: prompt }
        ];

        // We use Llama 3.3 70B as it is heavily optimized for perfect tool calling on Groq
        const response = await groq.chat.completions.create({
            model: "llama-3.3-70b-versatile",
            messages: messages,
            tools: tools,
            tool_choice: "auto"
        });

        const responseMessage = response.choices[0].message;

        // If the AI decides it needs to use a tool (like logTransaction)
        if (responseMessage.tool_calls) {
            messages.push(responseMessage); // Add the AI's tool request to the history

            for (const toolCall of responseMessage.tool_calls) {
                const args = JSON.parse(toolCall.function.arguments);
                let apiResponse;

                if (toolCall.function.name === "logTransaction") {
                    apiResponse = await logTransaction(args, messageId);
                } else if (toolCall.function.name === "analyzeFinances") {
                    apiResponse = await analyzeFinances(args);
                }

                // Push the tool's result back to the AI
                messages.push({
                    tool_call_id: toolCall.id,
                    role: "tool",
                    name: toolCall.function.name,
                    content: JSON.stringify(apiResponse)
                });
            }

            // Let the AI read the database response and formulate a human reply
            const finalResponse = await groq.chat.completions.create({
                model: "llama-3.3-70b-versatile",
                messages: messages
            });

            return finalResponse.choices[0].message.content || "✅ Task completed in the database.";
        }

        // If no tool was needed, just return the conversation
        return responseMessage.content || "I couldn't process that.";
    } catch (error) {
        console.error("Groq API Error:", error.message);
        return "Sorry, my brain encountered an error processing that.";
    }
}