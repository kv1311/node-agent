import db from '../config/database.js';
import { v4 as uuidv4 } from 'uuid';

export async function manageTask({ action, title, due_date, keyword }) {
  try {
    switch (action) {
      case 'create': {
        if (!title) return { status: 'Failed', error: 'title is required' };
        const id = uuidv4();
        await db.execute({
          sql: `INSERT INTO tasks (id, title, due_date, done) VALUES (?, ?, ?, 0)`,
          args: [id, title, due_date || '']
        });
        return { status: 'Success', details: `Task created: ${title}` };
      }
      case 'complete': {
        await db.execute({
          sql: `UPDATE tasks SET done = 1 WHERE title LIKE ? AND done = 0`,
          args: [`%${keyword || title}%`]
        });
        return { status: 'Success', details: `Marked done: ${keyword || title}` };
      }
      case 'delete': {
        await db.execute({
          sql: `DELETE FROM tasks WHERE title LIKE ?`,
          args: [`%${keyword || title}%`]
        });
        return { status: 'Success' };
      }
      case 'list': {
        const result = await db.execute(`SELECT * FROM tasks WHERE done = 0 ORDER BY created_at DESC`);
        return { status: 'Success', data: result.rows };
      }
    }
  } catch (error) {
    return { status: 'Failed', error: error.message };
  }
}

export async function manageReminder({ action, title, remind_at, keyword }) {
  try {
    switch (action) {
      case 'create': {
      const isoTime = remind_at;

      // Strict validation: ISO 8601 with time and optional timezone
      const isoRegex = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}([+-]\d{2}:\d{2}|Z)?$/;
      if (!isoTime || !isoRegex.test(isoTime)) {
        return {
          status: 'Error',
          details: `Invalid time format. Expected ISO 8601 like 2026-05-24T15:10:00+05:30. Got: "${isoTime}"`
        };
      }

      const id = uuidv4();
      await db.execute({
        sql: `INSERT INTO reminders (id, title, remind_at, done) VALUES (?, ?, ?, 0)`,
        args: [id, title, isoTime]
      });

      return {
        status: 'Success',
        details: `Reminder set: ${title} at ${isoTime}`
      };
    }
      case 'complete': {
        await db.execute({
          sql: `UPDATE reminders SET done = 1 WHERE title LIKE ?`,
          args: [`%${keyword || title}%`]
        });
        return { status: 'Success' };
      }
      case 'list': {
        const result = await db.execute(`SELECT * FROM reminders WHERE done = 0 ORDER BY remind_at ASC`);
        return { status: 'Success', data: result.rows };
      }
    }
  } catch (error) {
    return { status: 'Failed', error: error.message };
  }
}

export async function manageBill({ action, title, amount, due_date, keyword }) {
  try {
    switch (action) {
      case 'create': {
        const id = uuidv4();
        await db.execute({
          sql: `INSERT INTO bills (id, title, amount, due_date, paid) VALUES (?, ?, ?, ?, 0)`,
          args: [id, title, amount || 0, due_date || '']
        });
        return { status: 'Success', details: `Bill added: ${title} ₹${amount}` };
      }
      case 'mark_paid': {
        await db.execute({
          sql: `UPDATE bills SET paid = 1 WHERE title LIKE ?`,
          args: [`%${keyword || title}%`]
        });
        return { status: 'Success', details: `Marked paid: ${keyword || title}` };
      }
      case 'list': {
        const result = await db.execute(`SELECT * FROM bills WHERE paid = 0 ORDER BY due_date ASC`);
        return { status: 'Success', data: result.rows };
      }
    }
  } catch (error) {
    return { status: 'Failed', error: error.message };
  }
}

export async function manageEvent({ action, title, date, notes, keyword }) {
  try {
    switch (action) {
      case 'create': {
        const id = uuidv4();
        await db.execute({
          sql: `INSERT INTO events (id, title, date, notes) VALUES (?, ?, ?, ?)`,
          args: [id, title, date || '', notes || '']
        });
        return { status: 'Success', details: `Event added: ${title}` };
      }
      case 'list': {
        const result = await db.execute(`SELECT * FROM events ORDER BY date ASC`);
        return { status: 'Success', data: result.rows };
      }
      case 'delete': {
        await db.execute({
          sql: `DELETE FROM events WHERE title LIKE ?`,
          args: [`%${keyword || title}%`]
        });
        return { status: 'Success' };
      }
    }
  } catch (error) {
    return { status: 'Failed', error: error.message };
  }
}

export async function manageWatchlist({ action, title, type, genre, keyword }) {
  try {
    switch (action) {
      case 'create': {
        const id = uuidv4();
        await db.execute({
          sql: `INSERT INTO watchlist (id, title, type, genre, watched) VALUES (?, ?, ?, ?, 0)`,
          args: [id, title, type || 'movie', genre || '']
        });
        return { status: 'Success', details: `Added to watchlist: ${title}` };
      }
      case 'mark_watched': {
        await db.execute({
          sql: `UPDATE watchlist SET watched = 1 WHERE title LIKE ?`,
          args: [`%${keyword || title}%`]
        });
        return { status: 'Success' };
      }
      case 'list': {
        const result = await db.execute(`SELECT * FROM watchlist WHERE watched = 0 ORDER BY title ASC`);
        return { status: 'Success', data: result.rows };
      }
    }
  } catch (error) {
    return { status: 'Failed', error: error.message };
  }
}

export async function getContext() {
  try {
    const today = new Date().toISOString().split('T')[0];

    const [tasks, reminders, bills, events] = await Promise.all([
      db.execute(`SELECT title, due_date FROM tasks WHERE done = 0 ORDER BY created_at DESC LIMIT 5`),
      db.execute({ sql: `SELECT title, remind_at FROM reminders WHERE done = 0 AND remind_at >= ? ORDER BY remind_at ASC LIMIT 5`, args: [today] }),
      db.execute(`SELECT title, amount, due_date FROM bills WHERE paid = 0 ORDER BY due_date ASC LIMIT 5`),
      db.execute({ sql: `SELECT title, date FROM events WHERE date >= ? ORDER BY date ASC LIMIT 5`, args: [today] })
    ]);

    return {
      status: 'Success',
      pending_tasks: tasks.rows,
      reminders_today: reminders.rows,
      unpaid_bills: bills.rows,
      upcoming_events: events.rows
    };
  } catch (error) {
    return { status: 'Failed', error: error.message };
  }
}