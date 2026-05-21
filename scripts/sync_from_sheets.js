import { google } from 'googleapis';
import db from '../src/config/database.js';


const SHEET_ID = '1WrdRrKsoRtpdKSP_UPwfpfy7suCdJsEseVuCCCvhg8o';
const SHEET_NAME = 'Log'; 

const auth = new google.auth.GoogleAuth({
    keyFile: './google-credentials.json',
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
});

// Helper to convert "20-May-2026" into SQLite format "2026-05-20 00:00:00"
function formatToSQLDate(sheetDate) {
    const parts = sheetDate.split('-');
    if (parts.length === 3) {
        const months = {Jan:'01', Feb:'02', Mar:'03', Apr:'04', May:'05', Jun:'06', Jul:'07', Aug:'08', Sep:'09', Oct:'10', Nov:'11', Dec:'12'};
        const day = parts[0].padStart(2, '0');
        const month = months[parts[1]] || '01';
        return `${parts[2]}-${month}-${day} 00:00:00`;
    }
    return new Date().toISOString(); 
}

async function runMigration() {
    console.log(`\n🔄 Starting Data Backfill from Google Sheets...`);
    
    try {
        const sheets = google.sheets({ version: 'v4', auth });
        
        // Fetch columns A through E
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: SHEET_ID,
            range: `${SHEET_NAME}!A:E`,
        });

        const rows = response.data.values;
        if (!rows || rows.length === 0) {
            console.log('No data found in the sheet.');
            return;
        }

        console.log(`Found ${rows.length} total rows. Skipping header...`);

        // Prepare the SQL statement
        const insertStmt = db.prepare(`
            INSERT OR IGNORE INTO transactions 
            (message_id, date, description, type, account_source, amount, synced_to_cloud, category) 
            VALUES (?, ?, ?, ?, ?, ?, 1, 'legacy_import')
        `);

        let importedCount = 0;

        // Loop through rows (start at index 1 to skip the header)
        for (let i = 1; i < rows.length; i++) {
            const row = rows[i];
            
            // Map the sheet columns: [Date, Description, Type, Account, Amount]
            const dateStr = row[0] || '';
            const description = row[1] || 'Unknown';
            const type = (row[2] || 'outflow').toLowerCase();
            const account_source = row[3] || 'unknown';
            // Remove any commas or symbols from the amount string and parse to float
            const amount = parseFloat((row[4] || '0').replace(/[^0-9.-]+/g,"")); 

            const sqlDate = formatToSQLDate(dateStr);
            
            // Create a fake message_id so the UNIQUE constraint is satisfied
            const dummyMessageId = `legacy_import_row_${i}`;

            insertStmt.run(dummyMessageId, sqlDate, description, type, account_source, amount);
            importedCount++;
        }

        console.log(`✅ Successfully imported ${importedCount} transactions into SQLite.`);
        console.log(`Your local agent.db is now perfectly synced with Google Sheets!`);

    } catch (error) {
        console.error("Migration Error:", error);
    }
}

runMigration();