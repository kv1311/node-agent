import db from '../config/database.js';

export async function analyzeFinances({ time_frame }) {
    try {
        let dateCondition = "";
        const today = new Date();

        // Calculate the target month based on the AI's request
        if (time_frame === "current_month") {
            const currentMonth = today.toISOString().slice(0, 7); // Returns "YYYY-MM"
            dateCondition = `WHERE date LIKE '${currentMonth}%'`;
        } else if (time_frame === "last_month") {
            // Subtract exactly 1 month
            const lastMonthDate = new Date(today.getFullYear(), today.getMonth() - 1, 1);
            const lastMonth = lastMonthDate.toISOString().slice(0, 7);
            dateCondition = `WHERE date LIKE '${lastMonth}%'`;
        } else {
            dateCondition = ""; // For "all" time
        }

        // 1. Calculate overall Totals (Inflow vs Outflow)
        const totalsQuery = await db.execute(`
            SELECT type, SUM(amount) as total 
            FROM transactions 
            ${dateCondition} 
            GROUP BY type
        `);

        // 2. Calculate the Top 5 Expense Categories
        const categoryQuery = await db.execute(`
            SELECT category, SUM(amount) as total 
            FROM transactions 
            ${dateCondition ? dateCondition + " AND" : "WHERE"} type = 'outflow'
            GROUP BY category 
            ORDER BY total DESC 
            LIMIT 5
        `);

        // 3. Format a clean summary block to feed back to the AI's context window
        let summary = `Financial Analysis (${time_frame.replace('_', ' ').toUpperCase()}):\n\n`;
        
        if (totalsQuery.rows.length === 0) {
            return { status: "Success", data: `No transactions found for ${time_frame}.` };
        }

        summary += "TOTALS:\n";
        totalsQuery.rows.forEach(row => {
            summary += `- ${row.type.toUpperCase()}: ₹${row.total}\n`;
        });

        summary += "\nTOP EXPENSE CATEGORIES:\n";
        categoryQuery.rows.forEach(row => {
            summary += `- ${row.category}: ₹${row.total}\n`;
        });

        return { status: "Success", data: summary };
    } catch (error) {
        console.error("Analysis Error:", error);
        return { status: "Failed", error: error.message };
    }
}
export async function getRecentTransactions({ limit = 10 }) {
    try {
        const query = await db.execute({
            sql: `SELECT date, description, amount, category, account_source FROM transactions ORDER BY date DESC LIMIT ?`,
            args: [limit]
        });
        
        if (query.rows.length === 0) return { status: "Success", data: "No transactions found." };
        
        let result = `Last ${limit} Transactions:\n`;
        query.rows.forEach(row => {
            // Format: YYYY-MM-DD: Description (₹Amount) [Category]
            const cleanDate = row.date.split('T')[0];
            result += `- ${cleanDate}: ${row.description} (₹${row.amount}) [${row.category}]\n`;
        });
        
        return { status: "Success", data: result };
    } catch (error) {
        console.error("Fetch Recent Error:", error);
        return { status: "Failed", error: error.message };
    }
}