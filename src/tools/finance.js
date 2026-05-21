import { google } from 'googleapis';
import db from '../config/database.js';
import { updateMonthlyRollup } from '../config/database.js';

const SHEET_ID = '1WrdRrKsoRtpdKSP_UPwfpfy7suCdJsEseVuCCCvhg8o';
const SHEET_NAME = 'Log'; 

const auth = new google.auth.GoogleAuth({
    keyFile: './google-credentials.json', 
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

export async function logTransaction({ amount, type, category, description, owner = 'personal', account_source = 'unknown', date }, messageId) {
    try {
        // 1. Handle Custom Dates vs Current Date
        let transactionDate = new Date(); 
        if (date) {
            transactionDate = new Date(date);
        }
        
        const sqlDate = transactionDate.toISOString(); // For SQLite: YYYY-MM-DDTHH:mm:ss.sssZ
        const sheetDateStr = transactionDate.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }).replace(/ /g, '-');

        // 2. Save to SQLite (LibSQL)
        await db.execute({
            sql: `INSERT INTO transactions (message_id, amount, type, category, description, owner, account_source, date) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            args: [messageId, amount, type, category, description, owner, account_source, sqlDate]
        });
        
        // 3. Update the fast-read rollup
        await updateMonthlyRollup(sqlDate, amount, type, owner);

        // 4. Sync to Google Sheets
        const sheets = google.sheets({ version: 'v4', auth });
        
        await sheets.spreadsheets.values.append({
            spreadsheetId: SHEET_ID,
            range: `${SHEET_NAME}!A:E`, 
            valueInputOption: 'USER_ENTERED',
            insertDataOption: 'INSERT_ROWS',
            requestBody: { values: [[sheetDateStr, description, type, account_source, amount]] },
        });
        
        // 5. Mark as synced
        await db.execute({
            sql: `UPDATE transactions SET synced_to_cloud = 1 WHERE message_id = ?`,
            args: [messageId]
        });
        
        return { status: "Success", details: `Logged ₹${amount} for ${description} on ${sheetDateStr}` };
    } catch (error) {
        return { status: "Failed", error: error.message };
    }
}

export async function editTransaction({ search_description, new_amount, new_date }) {
    try {
        // 1. Find the exact transaction in SQLite
        const result = await db.execute({
            sql: `SELECT id, amount, date FROM transactions WHERE description LIKE ? ORDER BY date DESC LIMIT 1`,
            args: [`%${search_description}%`]
        });
        
        if (result.rows.length === 0) {
            return { status: "Failed", error: `Could not find any transaction matching '${search_description}'` };
        }

        const tx = result.rows[0];
        
        // 2. Apply the updates
        let amountToSet = new_amount || tx.amount;
        let dateToSet = new_date ? new Date(new_date).toISOString() : tx.date;

        await db.execute({ 
            sql: `UPDATE transactions SET amount = ?, date = ? WHERE id = ?`, 
            args: [amountToSet, dateToSet, tx.id] 
        });

        return { 
            status: "Success", 
            details: `Updated SQLite record for '${search_description}'. Note: Google Sheets API does not support safe row-editing yet, please manually fix the Sheet cell if necessary.` 
        };
    } catch (error) {
        return { status: "Failed", error: error.message };
    }
}