import { Telegraf } from 'telegraf';
import 'dotenv/config';
import { generateResponse } from '../ai/gemini.js';

export function initializeBot() {
    const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

    // Initial setup listener
    bot.start((ctx) => {
        const chatId = ctx.chat.id;
        const firstName = ctx.from.first_name;
        
        console.log(`[SYSTEM] Captured new Chat ID: ${chatId} for user ${firstName}`);
        // We will wire up the SQLite database insert here later
        
        ctx.reply(`Initialization complete, ${firstName}. My Gemini brain is connected.`);
    });

    // Listen for regular messages
    bot.on('text', async (ctx) => {
        const userMessage = ctx.message.text;
        
        // Show a "typing..." indicator in Telegram
        ctx.sendChatAction('typing');
        
        // Send message to Gemini and wait for the response
        const aiResponse = await generateResponse(userMessage);
        
        // Reply back to you in Telegram
        ctx.reply(aiResponse);
    });

    bot.launch();
    
    // Graceful stops for Node
    process.once('SIGINT', () => bot.stop('SIGINT'));
    process.once('SIGTERM', () => bot.stop('SIGTERM'));
}