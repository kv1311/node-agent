import db from '../config/database.js';
import { v4 as uuidv4 } from 'uuid';

export async function upsertMemoryNode({ canonical_key, label, type, metadata = {} }) {
    try {
        // 1. Soft-delete the old active node
        const existing = await db.execute({
            sql: `SELECT id FROM Nodes WHERE canonical_key = ? AND is_active = 1`,
            args: [canonical_key]
        });

        if (existing.rows.length > 0) {
            await db.execute({
                sql: `UPDATE Nodes SET is_active = 0, updated_at = CURRENT_TIMESTAMP WHERE canonical_key = ? AND is_active = 1`,
                args: [canonical_key]
            });
        }

        // 2. Insert the fresh node
        const newId = uuidv4();
        await db.execute({
            sql: `INSERT INTO Nodes (id, label, type, metadata, canonical_key, is_active) VALUES (?, ?, ?, ?, ?, 1)`,
            args: [newId, label, type, JSON.stringify(metadata), canonical_key]
        });

        return { status: "Success", details: `Memory saved. Key: ${canonical_key}` };
    } catch (error) {
        return { status: "Failed", error: error.message };
    }
}

// We update fetchMemories to only grab active facts for the system prompt
export async function fetchMemories() {
    try {
        const result = await db.execute(`SELECT label FROM Nodes WHERE is_active = 1`);
        if (result.rows.length === 0) return ["No custom memory loaded yet."];
        return result.rows.map(r => r.label);
    } catch (error) {
        return [];
    }
}