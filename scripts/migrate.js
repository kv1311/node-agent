
import { google } from 'googleapis';
import { v4 as uuidv4 } from 'uuid';
import db from '../src/config/database.js';
import 'dotenv/config';

// Re-use your existing auth
const auth = new google.auth.GoogleAuth({
    keyFile: 'credentials.json',
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

const SHEET_ID = process.env.SHEET_ID;
const SHEET_NAME = 'Sheet1'; // Change this if your tab is named differently

async function migrateData() {
    console.log("🚀 Starting Data Migration from Google Sheets to SQLite...");

    try {
        const sheets = google.sheets({ version: 'v4', auth });
        
        // 1. Fetch all rows from the sheet
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: SHEET_ID,
            range: `${SHEET_NAME}!A:E`, // Adjust if you have more columns
        });

        const rows = response.data.values;
        if (!rows || rows.length === 0) {
            console.log("⚠️ No data found in the spreadsheet.");
            return;
        }

        console.log(`📥 Found ${rows.length} rows. Parsing data...`);

        let successCount = 0;

        // 2. Loop through rows (skip the first row if it's a header)
        for (let i = 1; i < rows.length; i++) {
            const row = rows[i];
            
            // Map columns (Adjust these indexes based on your actual sheet layout)
            const sheetDate = row[0];       // e.g., "22-May-2026"
            const description = row[1];     // e.g., "HDFC CC Bill"
            const type = row[2] || "outflow"; 
            const account_source = row[3] || "unknown";
            const amountStr = row[4];

            if (!amountStr || !description) continue; // Skip empty rows

            // Clean the amount (remove currency symbols/commas)
            const amount = parseFloat(amountStr.replace(/[^0-9.-]+/g, ""));
            
            // Format the date for SQLite (YYYY-MM-DDTHH:mm:ss.sssZ)
            let sqlDate = new Date().toISOString();
            if (sheetDate) {
                // Quick parse for DD-MMM-YYYY format
                const parsedDate = new Date(sheetDate);
                if (!isNaN(parsedDate)) sqlDate = parsedDate.toISOString();
            }

            const messageId = uuidv4(); // Generate a fake Telegram ID for history
            const category = "Migrated"; // Default category for old data

            // 3. Insert into SQLite
            await db.execute({
                sql: `INSERT INTO transactions 
                      (message_id, amount, type, category, description, owner, account_source, date, synced_to_cloud) 
                      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
                args: [messageId, amount, type.toLowerCase(), category, description, 'personal', account_source, sqlDate]
            });

            successCount++;
        }

        console.log(`✅ Migration Complete! Successfully inserted ${successCount} records into SQLite.`);
        process.exit(0);

    } catch (error) {
        console.error("❌ Migration Failed:", error);
        process.exit(1);
    }
}

migrateData();