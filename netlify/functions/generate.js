const { fetchHeadlines } = require("../lib/news");

// Prompts live here, not in the browser, so this endpoint can only produce
// Daily Expedition content — it is not a general-purpose Gemini proxy.

const GEMINI_MODEL = "gemini-2.5-flash";

const LENS_GUIDE = {
  "Simply explained":     "Explain this for a curious intelligent non-specialist. Use concrete analogies. Avoid jargon.",
  "Go technical":         "Go deep into the technical or scientific mechanisms. Assume a well-educated reader who wants precision.",
  "Economic lens":        "Focus on economic dimensions — incentives, market structures, costs, trade-offs, consequences.",
  "Historical roots":     "Ground this in history. How did we arrive here? What are the deep roots and precedents?",
  "Opposing views":       "Present genuine tensions and disagreements. Where do serious thoughtful people disagree, and why?",
  "Second-order effects": "Think through downstream consequences. What might this change over 5–20 years?",
};

// Best-effort per-IP limit. Counts live in memory, so they reset when Netlify
// starts a fresh instance — enough to blunt casual abuse, not a hard guarantee.
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_MAX = 40;
const hits = new Map();

function rateLimited(ip) {
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < RATE_WINDOW_MS);
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 5000) hits.clear();
  return recent.length > RATE_MAX;
}

function json(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

function clip(value, max) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function describeDate(dateKey) {
  // dateKey is the reader's local YYYY-MM-DD; fall back to the server's date.
  const d = /^\d{4}-\d{2}-\d{2}$/.test(dateKey || "") ? new Date(dateKey + "T12:00:00Z") : new Date();
  return d.toLocaleDateString("en-US", { weekday: "short", year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
}

function expeditionPrompts(articles, excludeHeadline, dateKey) {
  const digest = articles.slice(0, 30)
    .map((a, i) => {
      const cats = (a.category || []).join(", ");
      const summary = clip(a.description, 240);
      return `${i + 1}. [${cats}] ${clip(a.title, 300)}${summary ? `\n   ${summary}` : ""}`;
    })
    .join("\n");

  const systemPrompt = `You are the editor of The Daily Expedition — a calm, intellectually serious daily briefing. Your reader is educated and broadly curious across geopolitics, economics, technology, science, energy, infrastructure, history, and culture.

Today is ${describeDate(dateKey)}. You have been given a list of real headlines from today's news, each with a short summary where available. Your task:
1. Choose the single most intellectually rich story — one that connects to larger systems, has historical depth, and opens multiple avenues of exploration. Avoid sports and pure celebrity news.
2. Write a compelling doorway into that story. Stay faithful to what the headline and summary actually report; do not invent specifics.
3. Generate six genuinely interesting questions it opens.

You MUST respond with only a valid JSON object. No explanation, no markdown, no code fences. Raw JSON only.

Schema:
{
  "headline": "A sharp newspaper-quality headline",
  "domain_tag": "one of: Geopolitics | Economics | Technology | Science | Energy | Infrastructure | Culture | History",
  "doorway": "Three to four sentences. Set the scene with authority. What happened, why it matters, what is genuinely uncertain. Write like a senior correspondent.",
  "questions": [
    { "tag": "Historical",   "text": "A question about how history led to this moment" },
    { "tag": "Systemic",     "text": "A question about the larger system or mechanism at play" },
    { "tag": "Geopolitical", "text": "A question about actors, power, and incentives" },
    { "tag": "Economic",     "text": "A question about market forces or financial consequences" },
    { "tag": "Scientific",   "text": "A question about the underlying technology or science" },
    { "tag": "Wildcard",     "text": "An unexpected adjacent question that becomes fascinating because of this event" }
  ]
}`;

  const exclude = clip(excludeHeadline, 300);
  const excludeNote = exclude
    ? `\n\nNote: an earlier pick for today was "${exclude}". Choose a different, genuinely distinct story this time.`
    : "";
  const userPrompt = `Here are today's headlines. Choose the best doorway and generate the expedition JSON:\n\n${digest}${excludeNote}`;

  return { systemPrompt, userPrompt };
}

function explorePrompts({ headline, doorway, question, lens }) {
  const lensNote = lens ? `\n\nLens: ${LENS_GUIDE[lens]}` : "";

  const systemPrompt = `You are a brilliant, measured intellectual guide for The Daily Expedition. You write with the depth and craft of a long-form magazine feature — flowing prose, not bullet points.

Today's event: "${headline}"
Context: ${doorway}

Write 4–5 substantive paragraphs exploring the question. Use a subheading only if genuinely needed. Every paragraph should reveal something. End with one sentence that opens a new direction, leaving the reader curious.${lensNote}`;

  const userPrompt = `Explore this question with depth and care: "${question}"`;

  return { systemPrompt, userPrompt };
}

async function callGemini(apiKey, systemPrompt, userPrompt, expectJson) {
  const generationConfig = { temperature: 0.8, maxOutputTokens: 8192 };
  if (expectJson) generationConfig.responseMimeType = "application/json";

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
    }
  );

  if (!response.ok) {
    const text = await response.text();
    return json(response.status, { error: `Gemini API error: ${text.slice(0, 500)}` });
  }

  const data = await response.json();
  const candidate = data?.candidates?.[0];
  const text = candidate?.content?.parts?.[0]?.text || "";

  if (!text) {
    const reason = candidate?.finishReason || data?.promptFeedback?.blockReason || "unknown reason";
    return json(502, { error: `Gemini returned no text (${reason}).` });
  }

  if (candidate?.finishReason === "MAX_TOKENS") {
    return json(200, { text, truncated: true });
  }

  return json(200, { text });
}

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
  if (!GEMINI_API_KEY) {
    return json(500, { error: "GEMINI_API_KEY is not set in environment variables." });
  }

  const ip = event.headers["x-nf-client-connection-ip"]
    || (event.headers["x-forwarded-for"] || "").split(",")[0].trim()
    || "unknown";
  if (rateLimited(ip)) {
    return json(429, { error: "Too many requests — please wait a few minutes and try again." });
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return json(400, { error: "Invalid JSON body." });
  }

  try {
    if (body.mode === "expedition") {
      const CURRENTS_API_KEY = process.env.CURRENTS_API_KEY;
      if (!CURRENTS_API_KEY) {
        return json(500, { error: "CURRENTS_API_KEY is not set in environment variables." });
      }
      const articles = await fetchHeadlines(CURRENTS_API_KEY);
      if (!articles.length) return json(502, { error: "No articles returned from news API." });

      const { systemPrompt, userPrompt } = expeditionPrompts(articles, body.excludeHeadline, body.date);
      return await callGemini(GEMINI_API_KEY, systemPrompt, userPrompt, true);
    }

    if (body.mode === "explore") {
      const headline = clip(body.headline, 300);
      const doorway = clip(body.doorway, 2000);
      const question = clip(body.question, 500);
      const lens = body.lens || null;
      if (!headline || !doorway || !question) {
        return json(400, { error: "Missing headline, doorway, or question." });
      }
      if (lens && !LENS_GUIDE[lens]) {
        return json(400, { error: "Unknown lens." });
      }

      const { systemPrompt, userPrompt } = explorePrompts({ headline, doorway, question, lens });
      return await callGemini(GEMINI_API_KEY, systemPrompt, userPrompt, false);
    }

    return json(400, { error: "Unknown mode." });
  } catch (err) {
    return json(500, { error: err.message });
  }
};
