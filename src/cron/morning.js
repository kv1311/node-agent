// src/cron/morning.js
import cron from 'node-cron'
import db from '../config/database.js'
import { log } from '../utils/log.js'
import Groq from 'groq-sdk'
import { GoogleGenerativeAI } from '@google/generative-ai'

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY })
const gemini = new GoogleGenerativeAI(process.env.GEMINI_API_KEY)

// ── Pull today's snapshot from DB ─────────────────────────────────────────────

async function getTodaySnapshot() {
  const today = new Date().toISOString().split('T')[0]
  const month = today.slice(0, 7)

  const [tasks, bills, reminders, events, spending] = await Promise.all([
    db.execute({
      sql: `SELECT title, due_date FROM tasks WHERE done = 0 ORDER BY created_at DESC LIMIT 5`,
      args: []
    }),
    db.execute({
      sql: `SELECT title, amount, due_date FROM bills WHERE paid = 0 ORDER BY due_date ASC LIMIT 5`,
      args: []
    }),
    db.execute({
      sql: `SELECT title, remind_at FROM reminders WHERE done = 0 AND remind_at >= ? ORDER BY remind_at ASC LIMIT 5`,
      args: [today]
    }),
    db.execute({
      sql: `SELECT title, date FROM events WHERE date >= ? ORDER BY date ASC LIMIT 3`,
      args: [today]
    }),
    db.execute({
      sql: `SELECT type, SUM(amount) as total FROM transactions WHERE date LIKE ? GROUP BY type`,
      args: [`${month}%`]
    })
  ])

  return {
    today,
    tasks: tasks.rows,
    bills: bills.rows,
    reminders: reminders.rows,
    events: events.rows,
    spending: spending.rows,
  }
}

// ── Build context string for the LLM ─────────────────────────────────────────

function buildSnapshotText(snapshot) {
  const { today, tasks, bills, reminders, events, spending } = snapshot
  const lines = [`Date: ${today}`]

  if (tasks.length) {
    lines.push(`\nPending tasks (${tasks.length}):`)
    tasks.forEach(t => lines.push(`  - ${t.title}${t.due_date ? ` · due ${t.due_date}` : ''}`))
  } else {
    lines.push('\nNo pending tasks.')
  }

  if (reminders.length) {
    lines.push(`\nReminders today (${reminders.length}):`)
    reminders.forEach(r => lines.push(`  - ${r.title} at ${r.remind_at}`))
  }

  if (bills.length) {
    lines.push(`\nUnpaid bills (${bills.length}):`)
    bills.forEach(b => lines.push(`  - ${b.title} ₹${b.amount}${b.due_date ? ` · due ${b.due_date}` : ''}`))
  }

  if (events.length) {
    lines.push(`\nUpcoming events:`)
    events.forEach(e => lines.push(`  - ${e.title} · ${e.date}`))
  }

  if (spending.length) {
    lines.push(`\nThis month's spending:`)
    spending.forEach(s => lines.push(`  - ${s.type}: ₹${Number(s.total).toLocaleString('en-IN')}`))
  }

  return lines.join('\n')
}

// ── Generate LLM briefing ─────────────────────────────────────────────────────

async function generateBriefing(snapshotText) {
  const systemPrompt = `You are Sia, a personal agent. Write a morning briefing for kv.

RULES:
- Max 5 lines. No bullet points. Plain text only (Telegram).
- Start with something time-aware or situational. Not "Good morning".
- Mention the most urgent 1-2 items specifically with numbers/amounts.
- If everything is clear, say so in one sharp line.
- End with one brief forward-looking note or quiet observation.
- Sound like a person who knows them well. No filler. No "Here is your briefing".
- TARS mode: precise, warm only if earned by the data.`

  const userMsg = `Today's data:\n${snapshotText}\n\nWrite the morning briefing.`

  // Try Groq first
  try {
    const res = await groq.chat.completions.create({
      model: 'llama-3.1-8b-instant',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMsg }
      ],
      max_tokens: 200,
    })
    return res.choices[0].message.content?.trim() || null
  } catch (groqErr) {
    log.warn(`[CRON] Groq briefing failed (${groqErr?.status}), trying Gemini`)
  }

  // Gemini fallback
  try {
    const model = gemini.getGenerativeModel({
      model: 'gemini-2.5-flash-lite',
      systemInstruction: systemPrompt,
    })
    const chat = model.startChat({ history: [] })
    const result = await chat.sendMessage(userMsg)
    return result.response.text()?.trim() || null
  } catch (geminiErr) {
    log.error('[CRON] Gemini briefing also failed:', geminiErr?.message)
    return null
  }
}

// ── Main scheduler ────────────────────────────────────────────────────────────

export function startMorningBriefing(bot) {
  // 8:00 AM IST every day
  cron.schedule('30 2 * * *', async () => {
    try {
      const chatId = process.env.TELEGRAM_CHAT_ID
      if (!chatId) {
        log.cron('TELEGRAM_CHAT_ID not set — briefing skipped')
        return
      }

      const snapshot = await getTodaySnapshot()
      const snapshotText = buildSnapshotText(snapshot)

      // Try LLM-generated briefing
      const llmBriefing = await generateBriefing(snapshotText)

      let message
      if (llmBriefing) {
        message = llmBriefing
      } else {
        // Deterministic fallback if both LLMs fail
        const lines = []
        if (snapshot.tasks.length) lines.push(`${snapshot.tasks.length} tasks pending.`)
        if (snapshot.bills.length) lines.push(`${snapshot.bills.length} unpaid bills.`)
        if (snapshot.reminders.length) lines.push(`${snapshot.reminders.length} reminders today.`)
        if (snapshot.events.length) lines.push(`${snapshot.events.length} events coming up.`)
        message = lines.length ? lines.join(' ') : 'Clear day ahead.'
      }

      await bot.telegram.sendMessage(chatId, message)
      log.cron('Morning briefing sent')

    } catch (error) {
      log.error('[CRON] Morning briefing failed:', error.message)
    }
  }, { timezone: 'Asia/Kolkata' })

  log.info('[CRON] Morning briefing scheduled for 8:00 AM IST')
}