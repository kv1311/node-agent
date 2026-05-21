import { Telegraf } from 'telegraf';
import 'dotenv/config';
import { generateResponse } from '../ai/gemini.js';

let bot;

export function initializeBot() {
    bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

    bot.start((ctx) => {
        const firstName = ctx.from.first_name;
        ctx.reply(`Initialization complete, ${firstName}. My Gemini brain is connected via Webhook.`);
    });

    bot.on('text', async (ctx) => {
        const userMessage = ctx.message.text;
        const messageId = ctx.message.message_id.toString(); 
        
        ctx.sendChatAction('typing');
        
        const aiResponse = await generateResponse(userMessage, messageId);
        ctx.reply(aiResponse);
    });

    process.once('SIGINT', () => bot.stop('SIGINT'));
    process.once('SIGTERM', () => bot.stop('SIGTERM'));
}

export const getBot = () => bot;