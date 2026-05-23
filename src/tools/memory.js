import db from '../config/database.js';
import { v4 as uuidv4 } from 'uuid';

// --- 1. UPSERT MEMORY (Type-2 SCD) ---
// Soft-deletes the old fact and inserts the new one to preserve history
export async function upsertMemoryNode({ canonical_key, label, type, metadata = {} }) {
    try {
        // Find if an active node already exists for this exact key
        const existing = await db.execute({
            sql: `SELECT id FROM Nodes WHERE canonical_key = ? AND is_active = 1`,
            args: [canonical_key]
        });

        // Soft-delete the old node (preserve history)
        if (existing.rows.length > 0) {
            await db.execute({
                sql: `UPDATE Nodes SET is_active = 0, updated_at = CURRENT_TIMESTAMP WHERE canonical_key = ? AND is_active = 1`,
                args: [canonical_key]
            });
        }

        // Insert the fresh, active node
        const newId = uuidv4();
        await db.execute({
            sql: `INSERT INTO Nodes (id, label, type, metadata, canonical_key, is_active) VALUES (?, ?, ?, ?, ?, 1)`,
            args: [newId, label, type, JSON.stringify(metadata), canonical_key]
        });

        return { status: "Success", details: `Memory saved. Key: ${canonical_key}` };
    } catch (error) {
        console.error("Memory Upsert Error:", error);
        return { status: "Failed", error: error.message };
    }
}

// --- 2. FETCH ACTIVE MEMORIES ---
// Grabs only current facts (is_active = 1) to inject into the AI's System Prompt
export async function fetchMemories() {
    try {
        const result = await db.execute(`SELECT label FROM Nodes WHERE is_active = 1`);
        
        if (result.rows.length === 0) {
            return ["No custom memory loaded yet."];
        }
        
        return result.rows.map(r => r.label);
    } catch (error) {
        console.error("Fetch Memories Error:", error);
        return [];
    }
}

// --- 3. CONFLICT DETECTION (Optional AI Tool) ---
// Allows the AI to search for similar concepts before writing
export async function findConflictingNodes({ label, type }) {
    try {
        const result = await db.execute({
            sql: `
                SELECT id, label, canonical_key, metadata, updated_at 
                FROM Nodes 
                WHERE type = ? 
                  AND is_active = 1 
                  AND (
                      label LIKE '%' || ? || '%' 
                      OR canonical_key LIKE ? || ':%'
                  )
                ORDER BY updated_at DESC 
                LIMIT 5
            `,
            args: [type, label, type]
        });
        return result.rows;
    } catch (error) {
        console.error("Find Conflicts Error:", error);
        return { status: "Failed", error: error.message };
    }
}

// --- 4. AUDIT TRAIL (Optional AI Tool) ---
// Allows the AI to look up the historical changes of a specific key
export async function getMemoryHistory({ canonical_key }) {
    try {
        const result = await db.execute({
            sql: `SELECT label, is_active, updated_at, metadata FROM Nodes WHERE canonical_key = ? ORDER BY updated_at DESC`,
            args: [canonical_key]
        });
        return result.rows;
    } catch (error) {
        console.error("Get Memory History Error:", error);
        return { status: "Failed", error: error.message };
    }
}

// --- 5. UPSERT EDGES ---
// Creates unique relationships between Nodes without duplicating
export async function upsertEdge(sourceId, targetId, relation, weight = 1.0) {
    try {
        const edgeId = uuidv4();
        await db.execute({
            sql: `
                INSERT INTO Edges (id, source_id, target_id, relation, weight) 
                VALUES (?, ?, ?, ?, ?) 
                ON CONFLICT(source_id, target_id, relation) 
                DO UPDATE SET weight = excluded.weight, created_at = CURRENT_TIMESTAMP
            `,
            args: [edgeId, sourceId, targetId, relation, weight]
        });
        return { status: "Success" };
    } catch (error) {
        console.error("Edge Upsert Error:", error);
        return { status: "Failed", error: error.message };
    }
}

export async function loadContext(conversationText = '') {
  try {
    const keywords = conversationText.toLowerCase().split(/\s+/).filter(w => w.length > 3);

    let sql = `SELECT canonical_key, label, type, metadata 
               FROM Nodes WHERE is_active = 1`;
    const args = [];

    // If we have keywords, surface relevant nodes first
    if (keywords.length > 0) {
      const conditions = keywords.map(() => `(label LIKE ? OR canonical_key LIKE ?)`).join(' OR ');
      sql += ` ORDER BY CASE WHEN ${conditions} THEN 0 ELSE 1 END, updated_at DESC LIMIT 12`;
      keywords.forEach(k => { args.push(`%${k}%`); args.push(`%${k}%`); });
    } else {
      sql += ` ORDER BY updated_at DESC LIMIT 20`;
    }

    const nodes = await db.execute({ sql, args });
    if (!nodes.rows || nodes.rows.length === 0) return '';

    const grouped = {};
    for (const node of nodes.rows) {
      const meta = JSON.parse(node.metadata || '{}');
      const type = node.type || 'general';
      if (!grouped[type]) grouped[type] = [];
      grouped[type].push({ key: node.canonical_key, label: node.label, ...meta });
    }
    
    let context = "MEMORY:\n"
    for (const node of nodes.rows) {
        const meta = JSON.parse(node.metadata || '{}')
        const metaStr = Object.keys(meta).length 
            ? ` (${Object.entries(meta).map(([k,v]) => `${k}:${v}`).join(', ')})`
            : ''
        context += `${node.canonical_key}: ${node.label}${metaStr}\n`
        }
    return context

  } catch (error) {
    console.error("loadContext error:", error);
    return '';
  }
}