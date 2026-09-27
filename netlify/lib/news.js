// Shared Currents API helper, bundled into functions by esbuild.
// Lives outside netlify/functions so Netlify doesn't expose it as its own endpoint.

const SKIP_CATEGORIES = ["sports", "sport", "entertainment", "lifestyle"];

async function fetchHeadlines(apiKey) {
  const url = `https://api.currentsapi.services/v1/latest-news?language=en&page_size=50&apiKey=${apiKey}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(12000) });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Currents API error (${response.status}): ${text.slice(0, 300)}`);
  }

  const data = await response.json();

  return (data.news || []).filter((article) => {
    const cats = article.category || [];
    return !cats.some((c) => SKIP_CATEGORIES.includes(String(c).toLowerCase()));
  });
}

module.exports = { fetchHeadlines };
