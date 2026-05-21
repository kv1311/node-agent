import { google } from 'googleapis';
import Database from 'better-sqlite3';

const db = new Database('agent.db');


const SHEET_ID = '1WrdRrKsoRtpdKSP_UPwfpfy7suCdJsEseVuCCCvhg8o';
const SHEET_NAME = 'Log'; 

const auth = new google.auth.GoogleAuth({
    keyFile: './google-credentials.json', // Ensure this file is in your root folder!
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

export async function logTransaction({ amount, type, category, description, owner = 'personal', account_source = 'unknown' }, messageId) {
    console.log(`\n--- NEW TRANSACTION TRIGGERED ---`);
    console.log(`[DATA] ₹${amount} | Type: ${type} | Account: ${account_source}`);
    
    try {
        console.log(`[DB] ⏳ Saving to SQLite...`);
        
        // Prevent duplicates!
        const stmt = db.prepare(`
             INSERT OR IGNORE INTO transactions 
             (message_id, amount, type, category, description, owner, account_source) 
             VALUES (?, ?, ?, ?, ?, ?, ?)
        `);
        const info = stmt.run(messageId, amount, type, category, description, owner, account_source);
        
        if (info.changes === 0) {
            console.log(`[DB] ⚠️ Duplicate message ignored.`);
            return `Duplicate transaction detected and ignored to protect database integrity.`;
        }
        
        console.log(`[DB] ✅ Saved to SQLite (Source of Truth).`);

        // Save to Google Sheets
        console.log(`[CLOUD] ⏳ Syncing to Google Sheets...`);
        const sheets = google.sheets({ version: 'v4', auth });
        
        const dateStr = new Date().toLocaleDateString('en-GB', { 
            day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' 
        }).replace(/ /g, '-');
        
        await sheets.spreadsheets.values.append({
            spreadsheetId: SHEET_ID,
            range: `${SHEET_NAME}!A:E`, 
            valueInputOption: 'USER_ENTERED',
            insertDataOption: 'INSERT_ROWS',
            requestBody: {
                values: [[dateStr, description, type, account_source, amount]],
            },
        });
        
        // Mark as synced locally
        db.prepare(`UPDATE transactions SET synced_to_cloud = 1 WHERE message_id = ?`).run(messageId);
        
        console.log(`[CLOUD] ✅ Successfully synced to Google Sheets.`);
        return `Success: Logged ₹${amount} for ${description} via ${account_source}.`;
        
    } catch (error) {
        console.error("\n❌ [ERROR] FINANCE TOOL CRASHED!");
        console.error("-> Basic Error Message:", error.message);
        if (error.response?.data?.error) {
            console.error("-> Google API Specifics:", error.response.data.error.message);
        }
        return `Data saved locally, but failed to sync to cloud: ${error.message}`;
    }
}