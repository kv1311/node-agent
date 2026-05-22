// export async function webSearch({ query, count = 5 }) {
//   try {
//     const response = await fetch(
//       `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}`,
//       {
//         headers: {
//           'Accept': 'application/json',
//           'Accept-Encoding': 'gzip',
//           'X-Subscription-Token': process.env.BRAVE_SEARCH_API_KEY
//         }
//       }
//     );

//     if (!response.ok) throw new Error(`Brave API: ${response.status}`);

//     const data = await response.json();
//     const results = data.web?.results || [];

//     if (results.length === 0) return { status: 'Success', data: 'No results found.' };

//     const summary = results.slice(0, count).map((r, i) =>
//       `${i + 1}. ${r.title}\n   ${r.description}\n   ${r.url}`
//     ).join('\n\n');

//     return { status: 'Success', data: summary };
//   } catch (error) {
//     return { status: 'Failed', error: error.message };
//   }
// }

export async function webSearch({ query, count = 5 }) {
  try {
    const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
    const response = await fetch(url);
    const data = await response.json();

    const results = [
      ...(data.RelatedTopics || []).filter(r => r.Text).slice(0, count)
    ];

    if (results.length === 0) {
      // Fallback: return the abstract if exists
      if (data.Abstract) return { status: 'Success', data: data.Abstract };
      return { status: 'Success', data: 'No results found.' };
    }

    const summary = results.map((r, i) =>
      `${i + 1}. ${r.Text}\n   ${r.FirstURL || ''}`
    ).join('\n\n');

    return { status: 'Success', data: summary };
  } catch (error) {
    return { status: 'Failed', error: error.message };
  }
}