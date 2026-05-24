// src/llm/openrouter.js
export async function callOpenRouterFree(messages, systemPrompt) {
  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'nvidia/nemotron-3-super-120b-a12b:free', // or 'meta-llama/llama-3.2-3b-instruct:free'
      messages: [
        { role: 'system', content: systemPrompt },
        ...messages.filter(m => m.role !== 'system')
      ],
      max_tokens: 1024,
    }),
  });
  const data = await response.json();
  return data.choices[0].message.content;
}