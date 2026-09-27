// Groups articles about the same story across outlets, then scores each story
// by how widely it's covered and whether people (Bluesky, HN) are paying
// attention. Plain word overlap — no embeddings needed at this scale (a few
// hundred headlines). Polymarket markets are matched later by Gemini: word
// overlap wrongly ties every "Trump" story to the 2028-election market.

const STOPWORDS = new Set(`
  a about above after again against all also am an and any are as at be because been before being below
  between both but by can could did do does doing down during each few for from further had has have having
  he her here hers him his how i if in into is it its just me more most my new no nor not now of off on once
  only or other our out over own said same says she should so some such than that the their them then there
  these they this those through to too under until up very was we were what when where which while who whom
  why will with would you your amid into say could may might year years day days week weeks
  first last latest live update updates report reports calls call people world time back
  make makes made take takes set sets get gets one two three four five mr mrs ms
`.split(/\s+/).filter(Boolean));

function stem(word) {
  if (word.length > 4 && word.endsWith("ies")) return word.slice(0, -3) + "y";
  if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
  return word;
}

export function tokenize(text) {
  const words = String(text || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/['’]s\b/g, "")
    .split(/[^a-z0-9]+/);
  const out = new Set();
  for (const w of words) {
    if (w.length < 3 || STOPWORDS.has(w) || /^\d+$/.test(w)) continue;
    out.add(stem(w));
  }
  return out;
}

function overlap(a, b) {
  let shared = 0;
  for (const t of a) if (b.has(t)) shared++;
  return { shared, ratio: shared / Math.max(1, Math.min(a.size, b.size)) };
}

// Two headlines are about the same story if they share at least two
// meaningful words and those make up a good share of the shorter one.
function sameStory(a, b) {
  const { shared, ratio } = overlap(a, b);
  return shared >= 3 || (shared >= 2 && ratio >= 0.4);
}

// A Bluesky trend matches a story when its short label shares two distinctive
// words with the story, or one plus most of the label. A missed trend costs a
// small boost; a wrong one misleads, so this errs toward precision. Words that turn up
// across many stories ("trump", "iran") can't carry a match alone, or a trend
// like "Trump approval poll" would attach itself to every Trump story.
// (Trend descriptions are too long and generic to match on.)
function trendMatches(labelTokens, storyTokens, isCommon) {
  let shared = 0;
  let distinctive = 0;
  for (const t of labelTokens) {
    if (!storyTokens.has(t)) continue;
    shared++;
    if (!isCommon(t)) distinctive++;
  }
  return distinctive >= 2 || (distinctive >= 1 && shared >= 2 && shared / labelTokens.size >= 0.6);
}

const NEWS_FAMILIES_EXCLUDED_FROM_COVERAGE = new Set(["Hacker News", "Wikipedia"]);

export function clusterStories({ articles, hackerNews, bluesky }) {
  const items = [...articles, ...hackerNews].map((item) => ({
    ...item,
    tokens: tokenize(item.title),
  })).filter((item) => item.tokens.size >= 2);

  const clusters = [];
  for (const item of items) {
    let home = null;
    for (const c of clusters) {
      if (c.members.some((m) => sameStory(m.tokens, item.tokens))) { home = c; break; }
    }
    if (home) home.members.push(item);
    else clusters.push({ members: [item] });
  }

  for (const c of clusters) {
    c.storyTokens = new Set();
    for (const m of c.members) {
      for (const t of m.tokens) c.storyTokens.add(t);
      for (const t of tokenize(m.summary)) c.storyTokens.add(t);
    }
  }

  const storiesPerToken = new Map();
  for (const c of clusters) {
    for (const t of c.storyTokens) storiesPerToken.set(t, (storiesPerToken.get(t) || 0) + 1);
  }
  const commonThreshold = Math.max(4, clusters.length * 0.03);
  const isCommon = (t) => (storiesPerToken.get(t) || 0) > commonThreshold;

  const trendTokens = bluesky.map((t) => ({ trend: t, tokens: tokenize(t.label) }));

  for (const c of clusters) {
    const { storyTokens } = c;

    const families = [...new Set(c.members.map((m) => m.family))];
    const outlets = families.filter((f) => !NEWS_FAMILIES_EXCLUDED_FROM_COVERAGE.has(f));
    const hn = c.members.filter((m) => m.family === "Hacker News")
      .sort((a, b) => b.points - a.points)[0] || null;
    const wikipedia = families.includes("Wikipedia");
    const trends = trendTokens.filter((t) => trendMatches(t.tokens, storyTokens, isCommon)).map((t) => t.trend);

    let score = outlets.length;
    if (wikipedia) score += 1.5;
    if (hn) score += Math.min(2, Math.log10(Math.max(10, hn.points)) - 1); // 100 pts ≈ +1, 1000 pts ≈ +2
    if (trends.length) score += 1 + Math.min(1, Math.log10(Math.max(1, trends[0].postCount)) / 4);

    // Lead with the member that has the most to say
    const lead = [...c.members].sort((a, b) =>
      (b.summary ? 1 : 0) - (a.summary ? 1 : 0) || b.summary.length - a.summary.length
    )[0];

    Object.assign(c, { lead, families, outlets, hn, wikipedia, trends, score });
  }

  return clusters.sort((a, b) => b.score - a.score);
}

// A compact, serialisable view of a story — stored with the expedition and used in prompts.
export function describeCluster(c) {
  const seen = new Set();
  const sources = [];
  for (const m of c.members) {
    if (!m.url || seen.has(m.family) || m.family === "Hacker News") continue;
    seen.add(m.family);
    sources.push({ source: m.family, title: m.title, url: m.url });
  }
  return {
    title: c.lead.title,
    summary: c.lead.summary,
    reporting: c.members
      .filter((m) => m.summary)
      .slice(0, 6)
      .map((m) => ({ source: m.family, title: m.title, summary: m.summary })),
    sources: sources.slice(0, 6),
    signals: {
      outlets: c.outlets,
      wikipedia: c.wikipedia,
      hackerNews: c.hn ? { title: c.hn.title, points: c.hn.points, comments: c.hn.comments, url: c.hn.discussionUrl } : null,
      bluesky: c.trends.slice(0, 2).map((t) => ({ label: t.label, postCount: t.postCount, url: t.url })),
    },
  };
}
