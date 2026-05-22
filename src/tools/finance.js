import db from '../config/database.js';
import { updateMonthlyRollup } from '../config/database.js';

export async function logTransaction({ amount, type, category, description, owner = 'personal', account_source = 'unknown', date }, messageId) {
  try {
    let transactionDate = date ? new Date(date) : new Date();
    const sqlDate = transactionDate.toISOString();

    await db.execute({
      sql: `INSERT INTO transactions (message_id, amount, type, category, description, owner, account_source, date) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [messageId, amount, type, category, description, owner, account_source, sqlDate]
    });

    await updateMonthlyRollup(sqlDate, amount, type, owner);

    return { 
      status: "Success", 
      details: `Logged ₹${amount} for ${description} on ${transactionDate.toLocaleDateString('en-IN')}` 
    };
  } catch (error) {
    return { status: "Failed", error: error.message };
  }
}

export async function editTransaction({ search_description, new_amount, new_date }) {
  try {
    const result = await db.execute({
      sql: `SELECT id, amount, date FROM transactions WHERE description LIKE ? ORDER BY date DESC LIMIT 1`,
      args: [`%${search_description}%`]
    });

    if (result.rows.length === 0) {
      return { status: "Failed", error: `No transaction found matching '${search_description}'` };
    }

    const tx = result.rows[0];
    const amountToSet = new_amount ?? tx.amount;
    const dateToSet = new_date ? new Date(new_date).toISOString() : tx.date;

    await db.execute({
      sql: `UPDATE transactions SET amount = ?, date = ? WHERE id = ?`,
      args: [amountToSet, dateToSet, tx.id]
    });

    return { status: "Success", details: `Updated: ${search_description}` };
  } catch (error) {
    return { status: "Failed", error: error.message };
  }
}