import { google } from 'googleapis';
import db from '../config/database.js';
import { updateMonthlyRollup } from '../config/database.js';

const SHEET_ID = '1WrdRrKsoRtpdKSP_UPwfpfy7suCdJsEseVuCCCvhg8o';
const SHEET_NAME = 'Log'; 

const auth = new google.auth.GoogleAuth({
    keyFile: './google-credentials.json', 
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

export async function logTransaction({ amount, type, category, description, owner = 'personal', account_source = 'unknown' }, messageId) {
    try {
        // Save to SQLite (LibSQL)
        await db.execute({
            sql: `INSERT INTO transactions (message_id, amount, type, category, description, owner, account_source) VALUES (?, ?, ?, ?, ?, ?, ?)`,
            args: [messageId, amount, type, category, description, owner, account_source]
        });
        
        // Update the fast-read rollup
        const isoDate = new Date().toISOString();
        await updateMonthlyRollup(isoDate, amount, type, owner);

        // Sync to Google Sheets
        const sheets = google.sheets({ version: 'v4', auth });
        const dateStr = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }).replace(/ /g, '-');
        
        await sheets.spreadsheets.values.append({
            spreadsheetId: SHEET_ID,
            range: `${SHEET_NAME}!A:E`, 
            valueInputOption: 'USER_ENTERED',
            insertDataOption: 'INSERT_ROWS',
            requestBody: { values: [[dateStr, description, type, account_source, amount]] },
        });
        
        // Mark as synced
        await db.execute({
            sql: `UPDATE transactions SET synced_to_cloud = 1 WHERE message_id = ?`,
            args: [messageId]
        });
        
        return { status: "Success", details: `Logged ₹${amount} for ${description}` };
    } catch (error) {
        return { status: "Failed", error: error.message };
    }
}