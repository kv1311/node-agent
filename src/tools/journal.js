import db from '../config/database.js';
import { v4 as uuidv4 } from 'uuid';

export async function manageJournal({ action, title, content, mood, tags, session_id, limit = 10, keyword }) {
  try {
    if (!action) {
      return { status: 'Failed', error: 'action is required. Must be one of: write, list, read, search, delete' };
    }
    switch (action) {

      case 'write': {
        if (!content?.trim()) return { status: 'Failed', error: 'content is required' };
        const id = uuidv4();
        const tagsStr = Array.isArray(tags) ? tags.join(',') : (tags || '');
        await db.execute({
          sql: `INSERT INTO journal (id, title, content, mood, tags, source_session) 
                VALUES (?, ?, ?, ?, ?, ?)`,
          args: [id, title || '', content, mood || '', tagsStr, session_id || '']
        });
        return { status: 'Success', id, details: `Journal entry saved.` };
      }

      case 'list': {
        const result = await db.execute({
          sql: `SELECT id, title, mood, tags, created_at, 
                SUBSTR(content, 1, 120) as preview 
                FROM journal 
                ORDER BY created_at DESC LIMIT ?`,
          args: [limit]
        });
        return { status: 'Success', data: result.rows };
      }

      case 'read': {
        const sql = keyword
          ? `SELECT * FROM journal WHERE content LIKE ? OR title LIKE ? ORDER BY created_at DESC LIMIT 1`
          : `SELECT * FROM journal ORDER BY created_at DESC LIMIT 1`;
        const args = keyword ? [`%${keyword}%`, `%${keyword}%`] : [];
        const result = await db.execute({ sql, args });
        if (result.rows.length === 0) return { status: 'Success', data: 'No entries found.' };
        return { status: 'Success', data: result.rows[0] };
      }

      case 'search': {
        if (!keyword) return { status: 'Failed', error: 'keyword required for search' };
        const result = await db.execute({
          sql: `SELECT id, title, mood, tags, created_at, SUBSTR(content, 1, 120) as preview 
                FROM journal 
                WHERE content LIKE ? OR title LIKE ? OR tags LIKE ?
                ORDER BY created_at DESC LIMIT ?`,
          args: [`%${keyword}%`, `%${keyword}%`, `%${keyword}%`, limit]
        });
        return { status: 'Success', data: result.rows };
      }

      case 'delete': {
        if (!keyword) return { status: 'Failed', error: 'keyword required to identify entry' };
        await db.execute({
          sql: `DELETE FROM journal WHERE id = ? OR title LIKE ?`,
          args: [keyword, `%${keyword}%`]
        });
        return { status: 'Success' };
      }

      default:
        return { status: 'Failed', error: `Unknown action: ${action}` };
    }
  } catch (error) {
    return { status: 'Failed', error: error.message };
  }
}