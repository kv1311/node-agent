import { GoogleGenerativeAI, SchemaType } from '@google/generative-ai';
import fs from 'fs';
import 'dotenv/config';
import { logTransaction } from '../tools/finance.js';
import { analyzeFinances } from '../tools/analyze.js';

const userProfile = JSON.parse(fs.readFileSync('./profile.json', 'utf8'));
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const financeTool = {
    name: "logTransaction",
    description: `Logs a financial transaction. Use this whenever the user spends or invests. If the user mentions investing ${userProfile.currency}${userProfile.investment_pools.uncle.target_monthly} for their Uncle, strictly set the 'owner' parameter to 'uncle'.`,
    parameters: {
        type: SchemaType.OBJECT,
        properties: {
            amount: { type: SchemaType.NUMBER, description: `Amount in ${userProfile.currency}.` },
            type: { type: SchemaType.STRING, description: "Exactly 'outflow' or 'inflow'." },
            category: { type: SchemaType.STRING, description: `Must be one of: ${userProfile.custom_categories.join(', ')}` },
            description: { type: SchemaType.STRING, description: "Short description (e.g., 'Family dinner')." },
            owner: { type: SchemaType.STRING, description: "Defaults to 'personal', but set to 'uncle' if tracking his funds." },
            account_source: { type: SchemaType.STRING, description: "e.g., 'HDFC', 'Zerodha'. Default: 'unknown'." }
        },
        required: ["amount", "type", "category", "description"]
    }
};

const analyzeTool = {
    name: "analyzeFinances",
    description: "Queries the SQLite database to answer questions about past spending.",
    parameters: {
        type: SchemaType.OBJECT,
        properties: {
            time_frame: { type: SchemaType.STRING, description: "'current_month', 'last_month', or 'all'" },
            type_filter: { type: SchemaType.STRING, description: "'inflow', 'outflow', or 'all'" }
        },
        required: ["time_frame"]
    }
};

const model = genAI.getGenerativeModel({
    model: "gemini-1.5-flash",
    tools: [{ functionDeclarations: [financeTool, analyzeTool] }],
    systemInstruction: `You are the personal assistant for ${userProfile.name}. You must use tools to log or retrieve data. Never make up numbers.`
});

export async function generateResponse(prompt, messageId) {
    try {
        const chat = model.startChat();
        let result = await chat.sendMessage(prompt);
        let response = result.response;

        if (response.functionCalls && response.functionCalls().length > 0) {
            const call = response.functionCalls()[0];
            
            if (call.name === "logTransaction") {
                const apiResponse = await logTransaction(call.args, messageId);
                apiResponse._instruction = "Confirm to the user that the transaction was logged perfectly.";
                
                result = await chat.sendMessage([{ functionResponse: { name: "logTransaction", response: apiResponse } }]);
                response = result.response;
            } else if (call.name === "analyzeFinances") {
                const apiResponse = await analyzeFinances(call.args);
                apiResponse._instruction = "Read the data array, do the math, and give the user a clear, conversational answer.";
                
                result = await chat.sendMessage([{ functionResponse: { name: "analyzeFinances", response: apiResponse } }]);
                response = result.response;
            }
        }
        
        return response.text() || "✅ Task completed in the database, but my language module forgot to reply!";
    } catch (error) {
        console.error("Gemini API Error:", error.message);
        return "Sorry, my brain encountered an error processing that.";
    }
}