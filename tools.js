// Web search via DuckDuckGo Lite (no API key required)
export async function webSearch(query, maxResults = 6) {
  const res = await fetch(
    `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`,
    {
      headers: {
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: AbortSignal.timeout(10000),
    }
  );

  if (!res.ok) throw new Error(`DuckDuckGo returned HTTP ${res.status}`);

  const html = await res.text();
  const results = [];

  const links    = [...html.matchAll(/<a[^>]+class="result-link"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g)];
  const snippets = [...html.matchAll(/<td[^>]+class="result-snippet"[^>]*>([\s\S]*?)<\/td>/g)];

  for (let i = 0; i < Math.min(maxResults, links.length); i++) {
    let href  = links[i][1];
    const title   = links[i][2].replace(/<[^>]+>/g, '').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').trim();
    const snippet = (snippets[i]?.[1] || '').replace(/<[^>]+>/g, '').replace(/&amp;/g,'&').replace(/&#x27;/g,"'").replace(/&quot;/g,'"').replace(/\s+/g,' ').trim();

    // Resolve DDG redirect URLs
    if (href.startsWith('/l/?') || href.includes('duckduckgo.com/l/?')) {
      try {
        const params = new URLSearchParams(href.includes('?') ? href.slice(href.indexOf('?') + 1) : href);
        href = decodeURIComponent(params.get('uddg') || href);
      } catch { /* keep original */ }
    }

    if (title && href.startsWith('http')) {
      results.push({ title, url: href, snippet });
    }
  }

  if (results.length === 0) throw new Error('No results found — try rephrasing the query.');
  return results;
}

// Fetch a webpage's readable content via Jina Reader (no API key required)
export async function fetchUrl(url) {
  const res = await fetch(`https://r.jina.ai/${url}`, {
    headers: {
      'Accept': 'text/plain',
      'X-Return-Format': 'markdown',
      'User-Agent': 'personal-assistant/2.0',
    },
    signal: AbortSignal.timeout(20000),
  });

  if (!res.ok) throw new Error(`Could not fetch ${url}: HTTP ${res.status}`);

  const text = await res.text();
  return text.length > 12000 ? text.slice(0, 12000) + '\n\n[content truncated]' : text;
}
