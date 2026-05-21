import { GoogleGenerativeAI, SchemaType } from '@google/generative-ai';
import 'dotenv/config';
import { logTransaction } from '../tools/finance.js';
import { analyzeFinances } from '../tools/analyze.js';

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const financeTool = {
    name: "logTransaction",
    description: "Logs a financial transaction into the local SQLite database and Google Sheets. You MUST use this tool whenever the user mentions spending, buying, paying, receiving, or investing money.",
    parameters: {
        type: SchemaType.OBJECT,
        properties: {
            amount: { type: SchemaType.NUMBER, description: "The transaction amount in INR (e.g., 1080.75)." },
            type: { type: SchemaType.STRING, description: "Must be exactly 'outflow' (if they paid/spent) or 'inflow' (if they received)." },
            category: { type: SchemaType.STRING, description: "The internal category, such as 'food', 'loan', 'mutual funds'." },
            description: { type: SchemaType.STRING, description: "A short description matching the user's input (e.g., 'Family dinner')." },
            owner: { type: SchemaType.STRING, description: "Defaults to 'personal'." },
            account_source: { type: SchemaType.STRING, description: "Identify how this was paid (e.g., 'Unity SF', 'HDFC', 'Slice', 'Kotak'). Default to 'unknown'." }
        },
        required: ["amount", "type", "category", "description"]
    }
};

const analyzeTool = {
    name: "analyzeFinances",
    description: "Reads the user's financial history from the database. Use this when the user asks questions like 'How much did I spend?', 'What are my expenses?', or 'Show my recent transactions'.",
    parameters: {
        type: SchemaType.OBJECT,
        properties: {
            time_frame: { 
                type: SchemaType.STRING, 
                description: "Must be exactly 'current_month', 'last_month', or 'all_time'." 
            },
            type_filter: { 
                type: SchemaType.STRING, 
                description: "Must be exactly 'inflow', 'outflow', or 'all'. Default is 'all'." 
            }
        },
        required: ["time_frame", "type_filter"]
    }
};

const model = genAI.getGenerativeModel({ 
    model: "gemini-2.5-flash-lite",
    tools: [{ functionDeclarations: [financeTool, analyzeTool] }],
    // FIX: Make the instruction incredibly strict about answering questions.
    systemInstruction: "You are a highly intelligent financial agent. If the user logs a transaction, confirm it. If they ask a question about their finances (like 'Can I afford this?'), you MUST use analyzeFinances, read the returned data, do the math, and give them a detailed, conversational answer. NEVER leave the user hanging."
});

export async function generateResponse(userMessage, messageId) {
    try {
        const chat = model.startChat();
        
        let result = await chat.sendMessage(userMessage);
        let response = result.response;
        
        const calls = response.functionCalls();
        
        if (calls && calls.length > 0) {
            const call = calls[0];
            
            if (call.name === "logTransaction") {
                console.log(`\n[SYSTEM] 🧠 AI executing logTransaction...`);
                const apiResponse = await logTransaction(call.args, messageId);
                
                // THE FIX: We pass ONLY the functionResponse, but sneak our instruction inside the JSON response!
                result = await chat.sendMessage([{ 
                    functionResponse: { 
                        name: "logTransaction", 
                        response: { 
                            result: apiResponse,
                            _instruction: "The transaction was just logged. You MUST reply to the user confirming it was saved successfully in a friendly tone."
                        } 
                    } 
                }]);
                response = result.response;
            }
            else if (call.name === "analyzeFinances") {
                console.log(`\n[SYSTEM] 🧠 AI executing analyzeFinances...`);
                const apiResponse = await analyzeFinances(call.args);
                
                // THE FIX: Trojan horse the instruction into the database results
                apiResponse._instruction = "Here is the data. You MUST read these numbers, do the math, and give the user a clear, conversational answer to their original question right now. Do not remain silent.";
                
                result = await chat.sendMessage([{ 
                    functionResponse: { 
                        name: "analyzeFinances", 
                        response: apiResponse 
                    } 
                }]);
                response = result.response;
            }
        }
        
        try {
            const finalReply = response.text();
            if (finalReply && finalReply.trim() !== '') {
                return finalReply;
            }
        } catch (textError) {
            console.error("AI refused to generate text:", textError);
        }
        
        return "✅ Task completed in the database, but my language module forgot to reply!";
        
    } catch (error) {
        console.error("Gemini API Error:", error.message);
        if (error.message.includes('503') || error.message.includes('429')) {
            return "⏳ My AI brain is currently experiencing high traffic. Give me a few seconds!";
        }
        return "Sorry, my brain encountered an error processing that.";
    }
}