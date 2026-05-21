import Database from 'better-sqlite3';

const db = new Database('agent.db');

export async function analyzeFinances({ time_frame, type_filter = 'all' }) {
    try {
        console.log(`\n[DB] 🔍 AI is analyzing finances. Timeframe: ${time_frame}, Filter: ${type_filter}`);
        
        let query = `SELECT amount, type, category, description, account_source, date FROM transactions WHERE 1=1`;
        const params = [];

        if (time_frame === 'current_month') {
            query += ` AND strftime('%Y-%m', date) = strftime('%Y-%m', 'now')`;
        } else if (time_frame === 'last_month') {
            query += ` AND strftime('%Y-%m', date) = strftime('%Y-%m', 'now', '-1 month')`;
        }

        if (type_filter !== 'all') {
            query += ` AND type = ?`;
            params.push(type_filter);
        }

        query += ` ORDER BY date DESC LIMIT 50`;

        const stmt = db.prepare(query);
        const results = stmt.all(...params);

        console.log(`[DB] ✅ Found ${results.length} records.`);
        
        // FIX: Return a clean object, not a string!
        return {
            status: "success",
            record_count: results.length,
            data: results
        };
    } catch (error) {
        console.error("Analyze Finances Error:", error);
        return JSON.stringify({ error: error.message });
    }
}