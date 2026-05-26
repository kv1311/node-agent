import { google } from 'googleapis';
import { v4 as uuidv4 } from 'uuid';
import db from '../config/database.js';
import 'dotenv/config';
import { writeMemoryFile, readMemoryFile } from './memory.js';   // new file‑based memory

const auth = new google.auth.GoogleAuth({
    keyFile: 'google-credentials.json',
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

export async function ingestGoogleSheet({ spreadsheet_id }) {
    try {
        const sheets = google.sheets({ version: 'v4', auth });
        
        const sheetInfo = await sheets.spreadsheets.get({ spreadsheetId: spreadsheet_id });
        const tabs = sheetInfo.data.sheets.map(sheet => sheet.properties.title);
        
        let totalInserted = 0;
        let processedTabs = [];

        const SKIP_TABS = ['dashboard', 'summary', 'overview', 'memory'];
        for (const tabName of tabs) {
            if (SKIP_TABS.includes(tabName.toLowerCase())) {
                console.log(`[SKIP] Ignoring tab: ${tabName}`);
                continue;
            }
            const response = await sheets.spreadsheets.values.get({
                spreadsheetId: spreadsheet_id,
                range: `${tabName}!A:E`,
            });

            const rows = response.data.values;
            if (!rows || rows.length < 2) continue;

            processedTabs.push(tabName);

            for (let i = 1; i < rows.length; i++) {
                const row = rows[i];
                const sheetDate = row[0];
                const description = row[1];
                const type = row[2] || "outflow";
                const account_source = row[3] || "unknown";
                const amountStr = String(row[4] || "");

                if (!amountStr || !description) continue;

                const cleanedAmount = amountStr.replace(/[^0-9.-]+/g, "");
                const amount = parseFloat(cleanedAmount);
                
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
        console.log(`[SYNC] Starting dynamic extraction for tab: ${tab_name}`);

        const sheets = google.sheets({ version: 'v4', auth });
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: spreadsheet_id,
            range: `${tab_name}!A:H`,
        });

        const rows = response.data.values;
        if (!rows || rows.length === 0) {
            return { status: "Failed", error: "Tab is empty or could not be found." };
        }

        const rawSheetData = rows
            .filter(row => row.length > 0 && row.some(cell => String(cell).trim() !== ''))
            .map(row => row.join(" | "))
            .join("\n");

        console.log(`[SYNC] Raw data fetched, ${rows.length} rows`);

        const systemPrompt = `You are a financial data extraction engine.
Rules:
1. Infer context from headers and data structure. Do not hardcode column names.
2. Return ONLY a valid JSON object with a single key "nodes" containing an array.
3. Every object in the array MUST have:
   - "canonical_key": snake_case unique ID (format: category:subcategory:name)
   - "label": clear human-readable name
   - "type": exactly one of: account | credit_card | loan | metric
   - "metadata": object with all relevant numeric/text fields from the data
4. Ignore empty rows and header-only rows.
5. No markdown, no backticks, no explanation. Raw JSON only.`;

        const userPrompt = `Extract all financial entities from this raw Google Sheets dashboard data:\n\n${rawSheetData}`;

        const groqResponse = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: 'llama3-70b-8192',
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user',   content: userPrompt   }
                ],
                response_format: { type: "json_object" },
                temperature: 0.1
            })
        });

        if (!groqResponse.ok) {
            const errBody = await groqResponse.text();
            throw new Error(`Groq API Error: ${groqResponse.status} - ${errBody}`);
        }

        const groqData = await groqResponse.json();
        const jsonText = groqData.choices[0].message.content.trim();
        console.log(`[SYNC] Groq responded, parsing JSON...`);

        let extractedNodes;
        try {
            const parsed = JSON.parse(jsonText);
            extractedNodes = parsed.nodes;
        } catch (err) {
            return { status: 'Failed', error: 'AI returned invalid JSON', raw: jsonText };
        }

        if (!Array.isArray(extractedNodes) || extractedNodes.length === 0) {
            return { status: 'Failed', error: 'AI returned empty or invalid nodes array', raw: jsonText };
        }

        // Write extracted entities to MEMORY.md (file‑based memory)
        const timestamp = new Date().toISOString().slice(0, 19).replace('T', ' ');
        let memoryEntry = `\n## Synced from Google Sheets (${tab_name}) on ${timestamp}\n`;
        for (const node of extractedNodes) {
            if (!node.canonical_key || !node.type) continue;
            const label = node.label || node.canonical_key;
            const meta = node.metadata || {};
            const metaStr = Object.entries(meta).map(([k, v]) => `${k}:${v}`).join(', ');
            memoryEntry += `- **${label}** (${node.type}) – ${metaStr}\n`;
        }

        // Append to MEMORY.md (environment memory)
        const result = await writeMemoryFile('env', 'append', memoryEntry);
        if (result.status === 'error') {
            return { status: 'Failed', error: result.error };
        }

        console.log(`[SYNC] Done. ${extractedNodes.length} entities written to MEMORY.md.`);
        return { status: 'Success', entities_synced: extractedNodes.length, memory_file: 'MEMORY.md' };

    } catch (error) {
        console.error("[SYNC] Dashboard Sync Error:", error);
        return { status: "Failed", error: error.message };
    }
}