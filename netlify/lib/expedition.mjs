// Builds a day's expedition from gathered sources. Prompts live server-side —
// the browser only ever names a date, a question, and a lens.

import { gatherSources } from "./sources.mjs";
import { clusterStories, describeCluster } from "./cluster.mjs";
import { gatherConversation } from "./conversation.mjs";
import { PREFERENCES } from "./preferences.mjs";

export const GEMINI_MODEL = "gemini-2.5-flash";
const CANDIDATE_LIMIT = 25;
const EXTRA_HN_CANDIDATES = 5;
const MARKET_LIMIT = 15;

export const LENS_GUIDE = {
  "Simply explained":     "Explain this for a curious intelligent non-specialist. Use concrete analogies. Avoid jargon.",
  "Go technical":         "Go deep into the technical or scientific mechanisms. Assume a well-educated reader who wants precision.",
  "Economic lens":        "Focus on economic dimensions — incentives, market structures, costs, trade-offs, consequences.",
  "Historical roots":     "Ground this in history. How did we arrive here? What are the deep roots and precedents?",
  "Opposing views":       "Present genuine tensions and disagreements. Where do serious thoughtful people disagree, and why?",
  "Second-order effects": "Think through downstream consequences. What might this change over 5–20 years?",
  "Public debate":        "Map the public argument about this. Identify the main camps, what each emphasises and fears, where they talk past each other, which of their claims are checkable and what the evidence says. Then name the perspectives missing from the sample and search for them — across the political spectrum and outside the US. Describe positions; don't quote or name individual posters.",
};

const DOMAIN_TAGS = ["Geopolitics", "Economics", "Technology", "Science", "Energy", "Infrastructure", "Culture", "History"];

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ---- Dates ----

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function localDateKey(timeZone, now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

// Somewhere on Earth it is currently this date (UTC−12 to UTC+14 spans at most yesterday..tomorrow in UTC).
export function isCurrentSomewhere(dateKey, now = new Date()) {
  return [-1, 0, 1].some((offset) =>
    new Date(now.getTime() + offset * 86400000).toISOString().slice(0, 10) === dateKey
  );
}

export function describeDate(dateKey) {
  return new Date(dateKey + "T12:00:00Z").toLocaleDateString("en-US", {
    weekday: "long", year: "numeric", month: "long", day: "numeric", timeZone: "UTC",
  });
}

// ---- Gemini ----

async function callGemini(systemPrompt, userPrompt, { json }) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new HttpError(500, "GEMINI_API_KEY is not set in environment variables.");

  const generationConfig = { temperature: 0.8, maxOutputTokens: 8192 };
  if (json) generationConfig.responseMimeType = "application/json";

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemPrompt }] },
        contents: [{ role: "user", parts: [{ text: userPrompt }] }],
        generationConfig,
      }),
      signal: AbortSignal.timeout(45000),
    }
  );

  if (!response.ok) {
    const text = await response.text();
    throw new HttpError(response.status, `Gemini API error: ${text.slice(0, 500)}`);
  }

  const data = await response.json();
  const candidate = data?.candidates?.[0];
  const text = candidate?.content?.parts?.[0]?.text || "";
  if (!text) {
    const reason = candidate?.finishReason || data?.promptFeedback?.blockReason || "unknown reason";
    throw new HttpError(502, `Gemini returned no text (${reason}).`);
  }
  return { text, truncated: candidate?.finishReason === "MAX_TOKENS" };
}

// Tolerates markdown fences or stray wrapping around the JSON object
function parseJson(raw) {
  try { return JSON.parse(raw); } catch {}
  const stripped = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
  try { return JSON.parse(stripped); } catch {}
  const match = stripped.match(/\{[\s\S]*\}/);
  if (match) {
    try { return JSON.parse(match[0]); } catch {}
  }
  throw new HttpError(502, "Could not parse JSON from Gemini response.");
}

function validateExpedition(data) {
  if (!data || typeof data !== "object") throw new HttpError(502, "Response was not a JSON object.");
  for (const key of ["headline", "domain_tag", "doorway"]) {
    if (!data[key] || typeof data[key] !== "string") throw new HttpError(502, `Response is missing "${key}".`);
  }
  if (!Array.isArray(data.questions) || data.questions.length !== 6) {
    throw new HttpError(502, "Response did not include exactly 6 questions.");
  }
  for (const q of data.questions) {
    if (!q || typeof q.tag !== "string" || !q.tag.trim() || typeof q.text !== "string" || !q.text.trim()) {
      throw new HttpError(502, "One or more questions is missing a tag or text.");
    }
  }
  return data;
}

// ---- Candidates ----

export async function prepareCandidates() {
  const gathered = await gatherSources({ currentsApiKey: process.env.CURRENTS_API_KEY });
  const clusters = clusterStories(gathered);

  const picked = clusters.slice(0, CANDIDATE_LIMIT);
  // Tech/science stories rarely hit several outlets at once; give the biggest HN threads a seat anyway.
  const hnExtras = clusters
    .filter((c) => !picked.includes(c) && c.hn)
    .sort((a, b) => b.hn.points - a.hn.points)
    .slice(0, EXTRA_HN_CANDIDATES);

  const stories = [...picked, ...hnExtras].map(describeCluster);
  if (stories.length < 5) {
    throw new HttpError(502, "Too few stories came back from the news sources. Please try again shortly.");
  }

  return {
    gatheredAt: new Date().toISOString(),
    stories,
    markets: gathered.polymarket.slice(0, MARKET_LIMIT),
    report: gathered.report,
  };
}

function formatAttention(signals) {
  const parts = [];
  if (signals.outlets.length) parts.push(`${signals.outlets.length} outlet${signals.outlets.length > 1 ? "s" : ""} (${signals.outlets.join(", ")})`);
  if (signals.wikipedia) parts.push("featured in Wikipedia's In the news");
  for (const t of signals.bluesky) parts.push(`trending on Bluesky: "${t.label}" (${t.postCount.toLocaleString("en-US")} posts)`);
  if (signals.hackerNews) parts.push(`Hacker News: ${signals.hackerNews.points} points, ${signals.hackerNews.comments} comments`);
  return parts.join(" · ");
}

export function formatMarket(m) {
  if (!m.lead) return m.title;
  const pct = Math.round(m.lead.probability * 100);
  return `${m.lead.question} — market says ${m.lead.outcome} ${pct < 1 ? "<1" : pct}%`;
}

function expeditionPrompts({ stories, markets }, dateKey, excluded, recent = []) {
  const digest = stories.map((s, i) => {
    const others = s.reporting
      .filter((r) => r.title !== s.title)
      .slice(0, 2)
      .map((r) => `"${r.title}" (${r.source})`)
      .join("; ");
    return [
      `[${i + 1}] ${s.title}`,
      s.summary && `    Summary: ${s.summary}`,
      others && `    Also reported: ${others}`,
      `    Attention: ${formatAttention(s.signals) || "single source"}`,
    ].filter(Boolean).join("\n");
  }).join("\n\n");

  const marketList = markets.map((m, i) => `M${i + 1}. ${formatMarket(m)}`).join("\n");

  const systemPrompt = `You are the editor of The Daily Expedition — a calm, intellectually serious daily briefing. Your reader is educated and broadly curious across geopolitics, economics, technology, science, energy, infrastructure, history, and culture.

Today is ${describeDate(dateKey)}. You have been given today's candidate stories, gathered from many outlets and grouped so that each candidate is one story. Each shows its summary and how much attention it is getting — how many outlets cover it, whether it's trending on Bluesky or Hacker News. You also have a list of active prediction markets.

Your task:
1. Choose the single most intellectually rich story — one that connects to larger systems, has historical depth, and opens multiple avenues of exploration. Broad attention is a useful signal of importance, but choose for depth: a less-covered story is right if it opens better questions. Avoid sports, celebrity, and pure crime or disaster stories unless they reveal something systemic.
2. Write a compelling doorway into that story. Stay faithful to what the summaries actually report; do not invent specifics.
3. Generate six genuinely interesting questions it opens.
4. List any prediction markets that bear directly on the chosen story (usually none or one; never a market that merely shares a name).
5. Give a short search query (3–6 words, no quotes or operators) that would find social media posts about this specific story.

You MUST respond with only a valid JSON object. No explanation, no markdown, no code fences. Raw JSON only.

Schema:
{
  "story_number": 1,
  "headline": "A sharp newspaper-quality headline",
  "domain_tag": "one of: ${DOMAIN_TAGS.join(" | ")}",
  "doorway": "Three to four sentences. Set the scene with authority. What happened, why it matters, what is genuinely uncertain. Write like a senior correspondent.",
  "questions": [
    { "tag": "Historical",   "text": "A question about how history led to this moment" },
    { "tag": "Systemic",     "text": "A question about the larger system or mechanism at play" },
    { "tag": "Geopolitical", "text": "A question about actors, power, and incentives" },
    { "tag": "Economic",     "text": "A question about market forces or financial consequences" },
    { "tag": "Scientific",   "text": "A question about the underlying technology or science" },
    { "tag": "Wildcard",     "text": "An unexpected adjacent question that becomes fascinating because of this event" }
  ],
  "market_ids": ["M1"],
  "search_query": "Iran Hormuz deal Trump"
}`;

  const interests = PREFERENCES.interests.filter(Boolean);
  const avoid = PREFERENCES.avoid.filter(Boolean);
  const preferenceNote = interests.length || avoid.length
    ? `\n\nThe reader's standing preferences (guidance, not rules — a clearly richer story still wins):${interests.length ? `\n- Favour: ${interests.join("; ")}` : ""}${avoid.length ? `\n- Steer away from: ${avoid.join("; ")}` : ""}`
    : "";

  const recentNote = recent.length
    ? `\n\nRecent picks (avoid repeating the same story, and prefer a different domain from the last two days, unless today brings a genuinely major new development):\n${recent.map((r) => `- ${r.date} [${r.domain_tag}] ${r.headline}`).join("\n")}`
    : "";

  const excludeNote = excluded.length
    ? `\n\nEarlier picks for today were: ${excluded.map((h) => `"${h}"`).join(", ")}. Choose a different, genuinely distinct story this time.`
    : "";

  const userPrompt = `Candidate stories:\n\n${digest}\n\nPrediction markets:\n${marketList || "(none available today)"}${preferenceNote}${recentNote}${excludeNote}`;

  return { systemPrompt, userPrompt };
}

// ---- Build a day ----

export async function buildExpedition(dateKey, { excluded = [], candidates = null, recent = [] } = {}) {
  const pool = candidates || await prepareCandidates();
  const { systemPrompt, userPrompt } = expeditionPrompts(pool, dateKey, excluded, recent);

  const { text, truncated } = await callGemini(systemPrompt, userPrompt, { json: true });
  if (truncated) throw new HttpError(502, "Gemini response was cut off before completing. Please try again.");
  const data = validateExpedition(parseJson(text));

  const story = pool.stories[Number(data.story_number) - 1] || null;
  const markets = (Array.isArray(data.market_ids) ? data.market_ids : [])
    .map((id) => pool.markets[Number(String(id).replace(/^M/i, "")) - 1])
    .filter(Boolean)
    .slice(0, 3)
    .map((m) => ({ title: m.title, lead: m.lead, url: m.url }));

  const signals = {
    ...(story ? story.signals : { outlets: [], wikipedia: false, hackerNews: null, bluesky: [] }),
    polymarket: markets,
  };
  const searchQuery = typeof data.search_query === "string" ? data.search_query.replace(/["']/g, "").trim().slice(0, 100) : "";
  const conversation = await gatherConversation(signals, searchQuery);

  return {
    date: dateKey,
    headline: data.headline.trim(),
    domain_tag: DOMAIN_TAGS.includes(data.domain_tag) ? data.domain_tag : data.domain_tag.trim(),
    doorway: data.doorway.trim(),
    questions: data.questions.map((q) => ({ tag: q.tag.trim(), text: q.text.trim() })),
    sources: story ? story.sources : [],
    reporting: story ? story.reporting : [],
    signals,
    conversation,
    candidates: pool,
    builtAt: new Date().toISOString(),
  };
}

// What the browser gets — no candidate pool, source report, prior versions, or
// captured posts (those feed the Public debate lens; the page links out instead).
export function publicView(record) {
  return {
    date: record.date,
    headline: record.headline,
    domain_tag: record.domain_tag,
    doorway: record.doorway,
    questions: record.questions,
    sources: record.sources || [],
    signals: record.signals || null,
    conversation: record.conversation
      ? {
          capturedAt: record.conversation.capturedAt,
          blueskyPosts: record.conversation.bluesky.length,
          hackerNewsComments: record.conversation.hackerNews.length,
        }
      : null,
    builtAt: record.builtAt,
  };
}
