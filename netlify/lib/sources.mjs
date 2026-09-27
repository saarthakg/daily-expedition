// Gathers today's raw material from free sources, in parallel.
// Every source is optional: a failure is recorded in the report and skipped,
// so one broken feed can never break the day's expedition.

const USER_AGENT = "DailyExpedition/1.0 (+https://github.com/saarthakg/daily-expedition)";
const SOURCE_TIMEOUT_MS = 8000;
const MAX_AGE_MS = 48 * 60 * 60 * 1000; // 48h so quiet weekend feeds still contribute

// Outlets chosen for world, economic, and science coverage — no sports or entertainment feeds.
const RSS_FEEDS = [
  { family: "BBC",         url: "https://feeds.bbci.co.uk/news/world/rss.xml" },
  { family: "BBC",         url: "https://feeds.bbci.co.uk/news/business/rss.xml" },
  { family: "BBC",         url: "https://feeds.bbci.co.uk/news/science_and_environment/rss.xml" },
  { family: "NPR",         url: "https://feeds.npr.org/1001/rss.xml" },
  { family: "Guardian",    url: "https://www.theguardian.com/world/rss" },
  { family: "Guardian",    url: "https://www.theguardian.com/science/rss" },
  { family: "NYT",         url: "https://rss.nytimes.com/services/xml/rss/nyt/World.xml" },
  { family: "Al Jazeera",  url: "https://www.aljazeera.com/xml/rss/all.xml" },
  { family: "DW",          url: "https://rss.dw.com/rdf/rss-en-all" },
  { family: "CNBC",        url: "https://www.cnbc.com/id/20910258/device/rss/rss.html" },
  { family: "Ars Technica", url: "https://feeds.arstechnica.com/arstechnica/index" },
  { family: "Nature",      url: "https://www.nature.com/nature.rss" },
];

const SKIP_CURRENTS_CATEGORIES = ["sports", "sport", "entertainment", "lifestyle"];
const SKIP_TREND_CATEGORIES = ["sports", "entertainment", "culture", "video-games"];
const SKIP_MARKET_TAGS = ["sports", "esports", "crypto", "crypto-prices", "pop-culture", "games", "mentions", "weather"];

async function getJson(url, init) {
  const res = await fetch(url, {
    ...init,
    headers: { "User-Agent": USER_AGENT, ...(init && init.headers) },
    signal: AbortSignal.timeout(SOURCE_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function getText(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(SOURCE_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

// ---- Text helpers ----

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

export function cleanText(s) {
  return String(s || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, name) => ENTITIES[name.toLowerCase()] ?? m)
    .replace(/<[^>]+>/g, " ") // entity-encoded markup, once decoded
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;:!?)])/g, "$1")
    .trim();
}

function clip(s, max) {
  return s.length > max ? s.slice(0, max - 1).trimEnd() + "…" : s;
}

function isFresh(dateString) {
  const t = Date.parse(dateString || "");
  return Number.isNaN(t) || Date.now() - t < MAX_AGE_MS;
}

// ---- RSS / Atom ----

function tagContent(block, name) {
  const m = block.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, "i"));
  return m ? m[1] : "";
}

export function parseFeed(xml) {
  const items = [];
  for (const [block] of xml.matchAll(/<(item|entry)\b[\s\S]*?<\/\1>/gi)) {
    const title = cleanText(tagContent(block, "title"));
    const link = cleanText(tagContent(block, "link"))
      || (block.match(/<link\b[^>]*href="([^"]+)"/i) || [])[1]
      || "";
    const summary = cleanText(tagContent(block, "description") || tagContent(block, "summary"));
    const published = cleanText(
      tagContent(block, "pubDate") || tagContent(block, "dc:date")
      || tagContent(block, "updated") || tagContent(block, "published")
    );
    if (title) items.push({ title, url: link, summary, published });
  }
  return items;
}

async function fetchFeed({ family, url }) {
  const items = parseFeed(await getText(url));
  return items
    .filter((i) => isFresh(i.published))
    .slice(0, 25)
    .map((i) => ({
      family,
      title: clip(i.title, 300),
      summary: clip(i.summary, 400),
      url: i.url,
      published: i.published,
    }));
}

// ---- Currents (optional; uses CURRENTS_API_KEY when set) ----

async function fetchCurrents(apiKey) {
  const data = await getJson(
    `https://api.currentsapi.services/v1/latest-news?language=en&page_size=50&apiKey=${apiKey}`
  );
  return (data.news || [])
    .filter((a) => !(a.category || []).some((c) => SKIP_CURRENTS_CATEGORIES.includes(String(c).toLowerCase())))
    .map((a) => ({
      family: "Currents",
      title: clip(cleanText(a.title), 300),
      summary: clip(cleanText(a.description), 400),
      url: a.url || "",
      published: a.published || "",
    }));
}

// ---- Hacker News front page ----

async function fetchHackerNews() {
  const data = await getJson("https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=30");
  return (data.hits || []).map((h) => ({
    family: "Hacker News",
    title: clip(cleanText(h.title), 300),
    summary: "",
    url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
    discussionUrl: `https://news.ycombinator.com/item?id=${h.objectID}`,
    points: h.points || 0,
    comments: h.num_comments || 0,
    published: h.created_at || "",
  }));
}

// ---- Wikipedia "In the news" (hand-curated; lags a few days, so it's a signal of significance) ----

async function fetchWikipediaNews() {
  const now = new Date();
  for (const offset of [0, 1]) {
    const d = new Date(now.getTime() - offset * 86400000);
    const path = `${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${String(d.getUTCDate()).padStart(2, "0")}`;
    try {
      const data = await getJson(`https://api.wikimedia.org/feed/v1/wikipedia/en/featured/${path}`);
      return (data.news || []).map((n) => {
        const main = (n.links || [])[0] || {};
        return {
          family: "Wikipedia",
          title: clip(cleanText(n.story), 300),
          summary: clip(cleanText(main.extract || ""), 400),
          url: main.content_urls?.desktop?.page || "",
          published: "",
        };
      });
    } catch (err) {
      if (offset === 1) throw err;
    }
  }
  return [];
}

// ---- Bluesky trends (signal only — what people are talking about) ----

async function fetchBlueskyTrends() {
  const data = await getJson("https://public.api.bsky.app/xrpc/app.bsky.unspecced.getTrends?limit=25");
  return (data.trends || [])
    .filter((t) => !SKIP_TREND_CATEGORIES.includes(String(t.category || "").toLowerCase()))
    .map((t) => ({
      label: cleanText(t.displayName),
      description: clip(cleanText(t.description || ""), 240),
      category: t.category || "",
      postCount: t.postCount || 0,
      url: t.link ? `https://bsky.app${t.link}` : "",
    }));
}

// ---- Polymarket (signal only — what money says is uncertain) ----

function leadingOutcome(event) {
  const now = Date.now();
  const open = (event.markets || []).filter((m) =>
    m.active && !m.closed && !(Date.parse(m.endDate || "") < now)
  );
  if (!open.length) return null;
  // Multi-market events list one Yes/No market per candidate ("who wins") or per
  // deadline ("ceasefire holds through Sep 30 / Oct 31 …"). Report the favourite,
  // skipping rungs that are already all-but-decided — "99% through tomorrow" says nothing.
  const undecided = open.filter((m) => {
    try {
      const p = Math.max(...JSON.parse(m.outcomePrices || "[]").map(Number));
      return p > 0.02 && p < 0.98;
    } catch {
      return false;
    }
  });
  const markets = open.length > 1 && undecided.length ? undecided : open;
  let best = null;
  for (const m of markets) {
    try {
      const outcomes = JSON.parse(m.outcomes || "[]");
      const prices = JSON.parse(m.outcomePrices || "[]").map(Number);
      if (!outcomes.length || outcomes.length !== prices.length) continue;
      const yesIdx = outcomes.findIndex((o) => String(o).toLowerCase() === "yes");
      const i = yesIdx >= 0 ? yesIdx : prices.indexOf(Math.max(...prices));
      if (!best || prices[i] > best.probability) {
        best = { question: cleanText(m.question || event.title), outcome: outcomes[i], probability: prices[i] };
      }
    } catch {
      // skip malformed market
    }
  }
  return best;
}

async function fetchPolymarket() {
  const data = await getJson(
    "https://gamma-api.polymarket.com/events?active=true&closed=false&order=volume24hr&ascending=false&limit=100"
  );
  return data
    .filter((e) => !(e.tags || []).some((t) => SKIP_MARKET_TAGS.includes(String(t.slug).toLowerCase())))
    .slice(0, 20)
    .map((e) => ({
      title: cleanText(e.title),
      description: clip(cleanText(e.description || ""), 240),
      volume24hr: Math.round(e.volume24hr || 0),
      lead: leadingOutcome(e),
      url: `https://polymarket.com/event/${e.slug}`,
    }));
}

// ---- Gather everything ----

async function settle(report, name, fn) {
  const started = Date.now();
  try {
    const result = await fn();
    report[name] = `ok (${result.length}) ${Date.now() - started}ms`;
    return result;
  } catch (err) {
    report[name] = `failed: ${err.message}`;
    return [];
  }
}

export async function gatherSources({ currentsApiKey } = {}) {
  const report = {};

  const articleJobs = RSS_FEEDS.map((feed) =>
    settle(report, `${feed.family} ${new URL(feed.url).pathname}`, () => fetchFeed(feed))
  );
  if (currentsApiKey) articleJobs.push(settle(report, "Currents", () => fetchCurrents(currentsApiKey)));
  articleJobs.push(settle(report, "Wikipedia", fetchWikipediaNews));

  const [articleLists, hackerNews, bluesky, polymarket] = await Promise.all([
    Promise.all(articleJobs),
    settle(report, "Hacker News", fetchHackerNews),
    settle(report, "Bluesky", fetchBlueskyTrends),
    settle(report, "Polymarket", fetchPolymarket),
  ]);

  return {
    articles: articleLists.flat(),
    hackerNews,
    bluesky,
    polymarket,
    report,
  };
}
