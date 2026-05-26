import db from '../config/database.js';
import { v4 as uuidv4 } from 'uuid';
import { log } from '../utils/log.js';
import { logTransaction } from './finance.js';

/**
 * Normalize party names for consistency
 * "me" → "me", "ramesh" → "Ramesh", "kotak bank" → "Kotak Bank"
 */
function normalizeParty(party) {
  if (!party) return null;
  if (party.toLowerCase() === 'me') return 'me';
  return party
    .split(/\s+/)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}

function validateObligation(args) {
  const errors = [];
  if (!args.from || !args.to) errors.push('Missing from or to party');
  if (!args.amount || args.amount <= 0) errors.push('Amount must be positive');
  if (args.from === args.to) errors.push('Cannot create obligation where from and to are the same');
  if (!args.purpose) errors.push('Purpose is required');
  if (args.due_date && !/^\d{4}-\d{2}-\d{2}$/.test(args.due_date))
    errors.push('Due date must be in YYYY-MM-DD format');
  if (args.installments && (args.installments < 1 || !Number.isInteger(args.installments)))
    errors.push('Installments must be a positive integer');
  return errors;
}

export async function createObligation(args) {
  try {
    const errors = validateObligation(args);
    if (errors.length) return { status: 'Failed', error: errors.join('; ') };

    const from = normalizeParty(args.from);
    const to = normalizeParty(args.to);
    const id = uuidv4();
    const now = new Date().toISOString();
    const remaining = args.amount;
    const currency = args.currency || 'INR';
    const installments = args.installments || 1;
    const purpose = args.purpose.toLowerCase();

    // Build human‑readable label (for DB metadata, not used elsewhere)
    let label = `${from} owes ${to} ₹${args.amount}`;
    if (args.due_date) {
      const dueDate = new Date(args.due_date).toLocaleDateString('en-IN', {
        day: 'numeric', month: 'short', year: 'numeric',
      });
      label += ` (due ${dueDate})`;
    }
    if (installments > 1) label += ` in ${installments} installments`;

    await db.execute({
      sql: `
        INSERT INTO obligations 
        (id, from_party, to_party, total_amount, remaining, currency, due_date, installments, purpose, status, metadata, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      args: [
        id, from, to, args.amount, remaining, currency,
        args.due_date || null, installments, purpose, 'active',
        JSON.stringify({ notes: args.notes || '', created_by: 'agent' }), now,
      ],
    });

    log.info(`[OBLIGATION] Created: ${id}`);
    return {
      status: 'Success',
      obligation_id: id,
      details: label,
      next_step: installments > 1
        ? `Split into ${installments} installments. Record each with record_settlement.`
        : null,
    };
  } catch (error) {
    log.error('[OBLIGATION CREATE]', error.message);
    return { status: 'Failed', error: error.message };
  }
}

export async function recordSettlement(args) {
  try {
    if (!args.obligation_id || !args.amount_paid) {
      return { status: 'Failed', error: 'Missing obligation_id or amount_paid' };
    }
    if (args.amount_paid <= 0) {
      return { status: 'Failed', error: 'Amount paid must be positive' };
    }

    const result = await db.execute({
      sql: `SELECT * FROM obligations WHERE id = ?`,
      args: [args.obligation_id],
    });
    if (!result.rows || !result.rows.length) {
      return { status: 'Failed', error: `Obligation ${args.obligation_id} not found` };
    }
    const oblig = result.rows[0];
    if (args.amount_paid > oblig.remaining) {
      return {
        status: 'Failed',
        error: `Cannot pay ₹${args.amount_paid}. Only ₹${oblig.remaining} remaining.`,
      };
    }

    const newRemaining = Math.max(0, oblig.remaining - args.amount_paid);
    const newPaidTotal = oblig.paid_total + args.amount_paid;
    const paymentDate = args.payment_date || new Date().toISOString().split('T')[0];
    const isFullyPaid = newRemaining === 0;

    const settlementId = uuidv4();
    await db.execute({
      sql: `
        INSERT INTO obligation_settlements 
        (id, obligation_id, amount_paid, payment_date, from_account, notes)
        VALUES (?, ?, ?, ?, ?, ?)
      `,
      args: [settlementId, args.obligation_id, args.amount_paid, paymentDate,
              args.from_account || 'unknown', args.notes || ''],
    });

    await db.execute({
      sql: `
        UPDATE obligations 
        SET paid_total = ?, remaining = ?, last_payment_date = ?, status = ?
        WHERE id = ?
      `,
      args: [newPaidTotal, newRemaining, paymentDate, isFullyPaid ? 'settled' : 'active', args.obligation_id],
    });

    // Log transaction for cash flow
    await logTransaction({
      amount: args.amount_paid,
      type: 'outflow',
      category: oblig.purpose === 'loan' ? 'loan_repayment' : 'debt_repayment',
      description: `Payment to ${oblig.to_party} for ${oblig.purpose}`,
      account_source: args.from_account || 'unknown',
      date: paymentDate,
    });

    log.info(`[SETTLEMENT] Recorded ₹${args.amount_paid} for obligation ${args.obligation_id}`);
    return {
      status: 'Success',
      paid: args.amount_paid,
      remaining: newRemaining,
      fully_settled: isFullyPaid,
      details: isFullyPaid
        ? 'Payment recorded. Obligation fully settled.'
        : `Payment recorded. ₹${newRemaining} remaining.`,
    };
  } catch (error) {
    log.error('[SETTLEMENT]', error.message);
    return { status: 'Failed', error: error.message };
  }
}

export async function queryObligations(args) {
  try {
    let sql = 'SELECT * FROM obligations WHERE 1=1';
    const sqlArgs = [];
    if (args.status && args.status !== 'any') {
      sql += ' AND status = ?';
      sqlArgs.push(args.status);
    }
    if (args.party && args.party !== 'all') {
      const party = normalizeParty(args.party);
      if (args.type === 'creditor') {
        sql += ' AND to_party = ? AND remaining > 0';
        sqlArgs.push(party);
      } else if (args.type === 'debtor') {
        sql += ' AND from_party = ? AND remaining > 0';
        sqlArgs.push(party);
      } else {
        sql += ' AND (from_party = ? OR to_party = ?)';
        sqlArgs.push(party, party);
      }
    }
    sql += ' ORDER BY updated_at DESC';
    const result = await db.execute({ sql, args: sqlArgs });

    if (!result.rows || !result.rows.length) {
      return { status: 'Success', obligations: [], summary: 'No obligations found.' };
    }
    const obligations = result.rows.map(o => ({
      id: o.id, from: o.from_party, to: o.to_party, total: o.total_amount,
      paid: o.paid_total, remaining: o.remaining, due: o.due_date,
      installments: o.installments, purpose: o.purpose, status: o.status,
    }));
    const totalOwed = obligations
      .filter(o => o.status === 'active')
      .reduce((sum, o) => sum + o.remaining, 0);
    return {
      status: 'Success',
      obligations,
      summary: `Found ${obligations.length} obligation(s). Total remaining: ₹${totalOwed.toFixed(2)}`,
    };
  } catch (error) {
    log.error('[QUERY OBLIGATIONS]', error.message);
    return { status: 'Failed', error: error.message };
  }
}

export async function updateBalance(args) {
  try {
    if (!args.account || !args.amount) {
      return { status: 'Failed', error: 'Missing account or amount' };
    }
    const account = args.account.trim();
    const amount = parseFloat(args.amount);
    const currency = args.currency || 'INR';
    if (isNaN(amount) || amount < 0) {
      return { status: 'Failed', error: 'Amount must be a non‑negative number' };
    }
    // Store balance in a dedicated table (not memory file)
    // For simplicity, we keep using a dedicated table 'accounts' – but that already exists.
    // Instead, we'll upsert into the accounts table.
    await db.execute({
      sql: `
        INSERT INTO accounts (id, name, type, balance, currency, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(name) DO UPDATE SET balance = ?, updated_at = ?
      `,
      args: [
        uuidv4(), account, 'bank', amount, currency, new Date().toISOString(),
        amount, new Date().toISOString(),
      ],
    });
    log.info(`[BALANCE] Updated ${account} to ₹${amount}`);
    return { status: 'Success', details: `${account} balance updated to ₹${amount.toFixed(2)}` };
  } catch (error) {
    log.error('[BALANCE UPDATE]', error.message);
    return { status: 'Failed', error: error.message };
  }
}

export async function getObligationDetail(args) {
  try {
    if (!args.obligation_id) return { status: 'Failed', error: 'Missing obligation_id' };
    const oblResult = await db.execute({
      sql: `SELECT * FROM obligations WHERE id = ?`,
      args: [args.obligation_id],
    });
    if (!oblResult.rows || !oblResult.rows.length) {
      return { status: 'Failed', error: 'Obligation not found' };
    }
    const oblig = oblResult.rows[0];
    const settlResult = await db.execute({
      sql: `SELECT * FROM obligation_settlements WHERE obligation_id = ? ORDER BY payment_date ASC`,
      args: [args.obligation_id],
    });
    const settlements = settlResult.rows || [];
    return {
      status: 'Success',
      obligation: {
        id: oblig.id, from: oblig.from_party, to: oblig.to_party,
        total: oblig.total_amount, paid: oblig.paid_total, remaining: oblig.remaining,
        due: oblig.due_date, installments: oblig.installments, purpose: oblig.purpose,
        status: oblig.status, created: oblig.created_at, lastPayment: oblig.last_payment_date,
      },
      settlements: settlements.map(s => ({
        date: s.payment_date, amount: s.amount_paid, account: s.from_account, notes: s.notes,
      })),
    };
  } catch (error) {
    log.error('[GET DETAIL]', error.message);
    return { status: 'Failed', error: error.message };
  }
}