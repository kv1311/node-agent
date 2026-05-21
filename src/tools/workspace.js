import { google } from 'googleapis';
import { v4 as uuidv4 } from 'uuid';
import db from '../config/database.js';
import 'dotenv/config';

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