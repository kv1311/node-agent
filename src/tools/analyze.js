import db from '../config/database.js';

export async function analyzeFinances({ time_frame, type_filter = 'all' }) {
    try {
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

        const result = await db.execute({ sql: query, args: params });
        const results = result.rows;

        return {
            status: "success",
            record_count: results.length,
            data: results
        };
    } catch (error) {
        return { status: "error", message: error.message };
    }
}