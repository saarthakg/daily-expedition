// Streams a long-form exploration, grounded with Google Search so today's
// specifics can be checked against live sources and cited.
//
// Google's grounding terms shape what happens downstream: the answer must be
// shown with its Search Suggestions, and must not be cached or shown to anyone
// but the person who asked. So nothing here is stored server-side — the reader's
// own browser keeps it as their reading history.

import { GEMINI_MODEL, LENS_GUIDE, HttpError, formatMarket, describeDate, DATE_RE } from "./expedition.mjs";

function explorePrompts(version, question, lens, dateKey) {
  const lensNote = lens ? `\n\nLens: ${LENS_GUIDE[lens]}` : "";

  const reporting = (version.reporting || [])
    .map((r) => `- ${r.source}: ${r.title}${r.summary ? ` — ${r.summary}` : ""}`)
    .join("\n");
  const reportingNote = reporting
    ? `\n\nWhat outlets reported when this story was chosen:\n${reporting}`
    : "";

  // Without a date the model searches with its own sense of "now" (it has
  // queried "Hormuz offer … 2018" for a 2026 story).
  const storyDate = DATE_RE.test(version.date || "") ? version.date : dateKey;
  const dateNote = DATE_RE.test(storyDate || "")
    ? `\nThis story was chosen on ${describeDate(storyDate)}; today is ${describeDate(new Date().toISOString().slice(0, 10))}.`
    : "";

  const markets = (version.signals?.polymarket || []).map((m) => `- ${formatMarket(m)}`).join("\n");
  const marketNote = markets ? `\n\nPrediction markets on this story when it was chosen:\n${markets}` : "";

  const systemPrompt = `You are a brilliant, measured intellectual guide for The Daily Expedition. You write with the depth and craft of a long-form magazine feature — flowing prose, not bullet points.

The event: "${version.headline}"${dateNote}
Context: ${version.doorway}${reportingNote}${marketNote}

Use Google Search to check current facts, figures, and developments before relying on them — especially anything about the event itself, which may have moved on. Search for coverage from the story's date onward; don't mistake an older event with a similar name for this one. Draw on your broader knowledge for history and context. Never invent specifics.

Write 4–5 substantive paragraphs exploring the question. Use a subheading only if genuinely needed. Every paragraph should reveal something. End with one sentence that opens a new direction, leaving the reader curious.${lensNote}`;

  const userPrompt = `Explore this question with depth and care: "${question}"`;

  return { systemPrompt, userPrompt };
}

async function openGeminiStream(systemPrompt, userPrompt, { grounded }) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new HttpError(500, "GEMINI_API_KEY is not set in environment variables.");

  const body = {
    system_instruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: "user", parts: [{ text: userPrompt }] }],
    generationConfig: { temperature: 0.8, maxOutputTokens: 8192 },
  };
  if (grounded) body.tools = [{ google_search: {} }];

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:streamGenerateContent?alt=sse`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(55000),
    }
  );
  if (!response.ok) {
    const text = await response.text();
    throw new HttpError(response.status, `Gemini API error: ${text.slice(0, 500)}`);
  }
  return response;
}

// Gemini's SSE stream: "data: {GenerateContentResponse}" blocks separated by blank lines
async function* readSse(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    const blocks = buffer.split(/\r?\n\r?\n/);
    buffer = done ? "" : blocks.pop();
    for (const block of blocks) {
      const data = block.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("");
      if (data) yield JSON.parse(data);
    }
    if (done) return;
  }
}

// Turns Gemini's grounding metadata into numbered citations and the character
// positions in the text where each citation marker belongs. Segments are
// located by their text rather than startIndex/endIndex, which can be UTF-8
// byte offsets and would drift past curly quotes and dashes.
export function buildCitations(text, metadata) {
  if (!metadata) return { citations: [], marks: [], searchSuggestions: "", queries: [] };

  const chunks = metadata.groundingChunks || [];
  const citations = [];
  const numberFor = new Map();
  const cite = (i) => {
    const web = chunks[i]?.web;
    if (!web?.uri) return null;
    if (!numberFor.has(i)) {
      numberFor.set(i, citations.length + 1);
      citations.push({ n: citations.length + 1, title: web.title || new URL(web.uri).hostname, url: web.uri });
    }
    return numberFor.get(i);
  };

  const marks = [];
  let cursor = 0;
  for (const support of metadata.groundingSupports || []) {
    const segment = support.segment?.text;
    if (!segment) continue;
    let at = text.indexOf(segment, cursor);
    if (at === -1) at = text.indexOf(segment);
    if (at === -1) continue;
    cursor = at;
    const refs = [...new Set((support.groundingChunkIndices || []).map(cite).filter(Boolean))];
    if (refs.length) marks.push({ at: at + segment.length, refs });
  }

  // Sources the model consulted but didn't tie to a sentence still get listed
  chunks.forEach((_, i) => cite(i));

  return {
    citations,
    marks,
    searchSuggestions: metadata.searchEntryPoint?.renderedContent || "",
    queries: metadata.webSearchQueries || [],
  };
}

// Opens the upstream stream before the response starts, so request errors
// (bad key, quota) still reach the browser as a normal HTTP error. If grounding
// itself is refused — e.g. its daily quota is used up — falls back to an
// ungrounded answer rather than failing.
export async function openExploration(version, question, lens, dateKey) {
  const { systemPrompt, userPrompt } = explorePrompts(version, question, lens, dateKey);

  let grounded = true;
  let upstream;
  try {
    upstream = await openGeminiStream(systemPrompt, userPrompt, { grounded });
  } catch (err) {
    if (err.status !== 400 && err.status !== 429) throw err;
    console.warn("explore: grounding unavailable, answering without it:", err.message);
    grounded = false;
    upstream = await openGeminiStream(systemPrompt, userPrompt, { grounded });
  }

  // Events for the browser, one JSON object per line
  async function* events() {
    let text = "";
    let metadata = null;
    let finishReason = null;
    for await (const chunk of readSse(upstream)) {
      const candidate = chunk.candidates?.[0];
      const delta = (candidate?.content?.parts || []).map((p) => p.text || "").join("");
      if (delta) {
        text += delta;
        yield { type: "text", text: delta };
      }
      if (candidate?.groundingMetadata) metadata = candidate.groundingMetadata;
      if (candidate?.finishReason) finishReason = candidate.finishReason;
    }
    if (!text) throw new HttpError(502, `Gemini returned no text (${finishReason || "unknown reason"}).`);
    yield {
      type: "done",
      grounded,
      truncated: finishReason === "MAX_TOKENS",
      ...buildCitations(text, metadata),
    };
  }

  return events();
}
