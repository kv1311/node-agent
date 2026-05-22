import { google } from 'googleapis';
import { v4 as uuidv4 } from 'uuid';
import db from '../config/database.js';
import 'dotenv/config';

import { upsertMemoryNode } from './memory.js';

const auth = new google.auth.GoogleAuth({
    keyFile: 'google-credentials.json',
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

export async function ingestGoogleSheet({ spreadsheet_id }) {
    try {
        const sheets = google.sheets({ version: 'v4', auth });
        
        // 1. Dynamically fetch all tab names in the spreadsheet
        const sheetInfo = await sheets.spreadsheets.get({ spreadsheetId: spreadsheet_id });
        const tabs = sheetInfo.data.sheets.map(sheet => sheet.properties.title);
        
        let totalInserted = 0;
        let processedTabs = [];

        // 2. Loop through every tab
        for (const tabName of tabs) {
            const response = await sheets.spreadsheets.values.get({
                spreadsheetId: spreadsheet_id,
                range: `${tabName}!A:E`, // Assuming standard A-E columns
            });

            const rows = response.data.values;
            if (!rows || rows.length < 2) continue; // Skip empty sheets

            processedTabs.push(tabName);

            // 3. Loop through rows and insert (skipping header)
            for (let i = 1; i < rows.length; i++) {
                const row = rows[i];
                
               const sheetDate = row[0];       
                const description = row[1];     
                const type = row[2] || "outflow"; 
                const account_source = row[3] || "unknown";
                
                // 1. Safely grab the amount as a string
                const amountStr = String(row[4] || "");

                if (!amountStr || !description) continue;

                const cleanedAmount = amountStr.replace(/[^0-9.-]+/g, "");
                const amount = parseFloat(cleanedAmount);
                
                // --- MISSING SAFETY CHECK GOES HERE ---
                if (isNaN(amount)) {
                    console.log(`[WARNING] Skipping row with invalid amount: ${amountStr}`);
                    continue; 
                }
                let sqlDate = new Date().toISOString();
                if (sheetDate) {
                    const parsedDate = new Date(sheetDate);
                    if (!isNaN(parsedDate)) sqlDate = parsedDate.toISOString();
                }

                const messageId = uuidv4(); 
                const category = "Migrated"; 

                await db.execute({
                    sql: `INSERT INTO transactions 
                          (message_id, amount, type, category, description, owner, account_source, date, synced_to_cloud) 
                          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
                    args: [messageId, amount, type.toLowerCase(), category, description, 'personal', account_source, sqlDate]
                });

                totalInserted++;
            }
        }

        return { 
            status: "Success", 
            data: `Migration complete. Inserted ${totalInserted} rows from tabs: ${processedTabs.join(', ')}.` 
        };

    } catch (error) {
        console.error("Ingestion Error:", error);
        return { status: "Failed", error: error.message };
    }
}

export async function syncDashboardMemory({ spreadsheet_id, tab_name }) {
    if (!spreadsheet_id || !tab_name) {
        return { status: "Failed", error: "Missing required parameters: spreadsheet_id and tab_name." };
    }

    try {
        console.log(`[SYNC] Starting Groq-powered dynamic extraction for tab: ${tab_name}`);

        // ==========================================
        // STEP 1: Fetch raw rows from Sheets
        // ==========================================
        const sheets = google.sheets({ version: 'v4', auth });
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: spreadsheet_id,
            range: `${tab_name}!A:H`,
        });

        const rows = response.data.values;
        if (!rows || rows.length === 0) {
            return { status: "Failed", error: "Tab is empty or could not be found." };
        }

        // Convert rows to a pipe-separated plain text string (ignoring empty rows)
        const rawSheetData = rows
            .filter(row => row.length > 0 && row.some(cell => cell.trim() !== ''))
            .map(row => row.join(" | "))
            .join("\n");

        // ==========================================
        // STEP 2: Send raw text to Groq API (Llama 3 70B)
        // ==========================================
        const prompt = `
You are a financial data extraction engine. Read the following raw, pipe-separated Google Sheets data.
Extract every distinct financial entity you find (e.g., credit cards, loans, cash accounts, summary metrics).

Rules:
1. Infer the context from the headers and data structure. Do not assume hardcoded column names.
2. Return ONLY a valid JSON object with a single key "nodes" that contains an array of objects. Do not include markdown or conversational text.
3. Every object in the "nodes" array MUST have the following schema:
   - "canonical_key": A snake_case unique identifier (format: category:subcategory:name, e.g., credit_card:hdfc:millennia).
   - "label": A clear, human-readable summary of the entity.
   - "type": Must be exactly one of: account | credit_card | loan | metric.
   - "metadata": A JSON object containing all relevant fields inferred from the columns (e.g., limit, due, principal).

Raw Data:
${rawSheetData}
`;

        const groqResponse = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: 'llama3-70b-8192', // Use the 70B model for strict JSON reasoning
                messages: [{ role: 'system', content: prompt }],
                response_format: { type: "json_object" }, // Forces Groq to output raw JSON
                temperature: 0.1 // Low temperature for maximum deterministic accuracy
            })
        });

        if (!groqResponse.ok) {
            const errBody = await groqResponse.text();
            throw new Error(`Groq API Error: ${groqResponse.status} - ${errBody}`);
        }

        const groqData = await groqResponse.json();
        const jsonText = groqData.choices[0].message.content.trim();

        // ==========================================
        // STEP 3: Upsert Extracted Nodes
        // ==========================================
        let extractedNodes;
        try {
            // Because we asked for { "nodes": [...] }, we extract the array here
            const parsed = JSON.parse(jsonText);
            extractedNodes = parsed.nodes;
        } catch (error) {
            return { 
                status: 'Failed', 
                error: 'AI returned invalid JSON', 
                raw: jsonText 
            };
        }

        if (!Array.isArray(extractedNodes)) {
            return { status: 'Failed', error: 'AI did not return a valid nodes array.', raw: jsonText };
        }

        let syncedCount = 0;
        let syncedKeys = [];

        for (const node of extractedNodes) {
            // Validation
            if (!node.canonical_key || !node.type || !node.metadata) {
                console.warn("[WARNING] Skipping malformed node from AI:", node);
                continue;
            }

            // Upsert to SQLite Memory Graph
            await upsertMemoryNode({
                canonical_key: node.canonical_key,
                label: node.label || `Entity: ${node.canonical_key}`,
                type: node.type,
                metadata: node.metadata
            });

            syncedCount++;
            syncedKeys.push(node.canonical_key);
        }

        return { 
            status: 'Success', 
            nodes_synced: syncedCount, 
            keys: syncedKeys 
        };

    } catch (error) {
        console.error("Dashboard Sync Error:", error);
        return { status: "Failed", error: error.message };
    }
}