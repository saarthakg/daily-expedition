// POST /api/explore {date, headline, questionIndex, lens} → a streamed, grounded exploration.
// The question and its context come from the stored expedition, never from the request —
// except a reader's own question ({customQuestion, parentIndex}), which is length-capped,
// only allowed on a stored day, and limited site-wide per day.
// Response: newline-delimited JSON — {type:"text", text} deltas, then one
// {type:"done", citations, marks, searchSuggestions, grounded, truncated}, or {type:"error"}.

import { LENS_GUIDE, DATE_RE, HttpError } from "../lib/expedition.mjs";
import { openExploration } from "../lib/explore.mjs";
import { openStore, getDay, bumpDailyCount } from "../lib/store.mjs";

// Archive entries saved in the browser before server-side storage existed have no
// stored record. Until this date they may send their own text (length-capped);
// by then every such entry has aged out of the 14-day archive.
const LEGACY_FALLBACK_UNTIL = Date.parse("2026-10-12T00:00:00Z");

// Readers' own questions are the one free-text input, so they get a hard
// site-wide daily ceiling on top of the per-IP rate limit.
const CUSTOM_QUESTION_MAX_CHARS = 280;
const CUSTOM_QUESTIONS_PER_DAY = 50;

export const config = {
  path: "/api/explore",
  method: "POST",
  rateLimit: { windowLimit: 12, windowSize: 60, aggregateBy: ["ip", "domain"] },
};

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function clip(value, max) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

// The stored day may have been regenerated since the reader loaded it;
// find whichever version they're looking at.
function findVersion(record, headline) {
  const versions = [record, ...(record.history || [])];
  return versions.find((v) => v.headline === headline) || null;
}

function legacyVersion(body) {
  const headline = clip(body.headline, 300);
  const doorway = clip(body.doorway, 2000);
  const question = clip(body.question, 500);
  if (!headline || !doorway || !question) return null;
  return { version: { headline, doorway }, question };
}

export default async (req, context) => {
  let body;
  try { body = await req.json(); } catch { return json(400, { error: "Invalid JSON body." }); }

  const lens = body.lens || null;
  if (lens && !LENS_GUIDE[lens]) return json(400, { error: "Unknown lens." });

  try {
    let version = null;
    let question = null;
    let asked = null;

    const store = openStore(context?.deploy?.context);
    const record = DATE_RE.test(body.date || "") ? await getDay(store, body.date) : null;
    const stored = record ? findVersion(record, body.headline) : null;
    const isCustom = body.customQuestion != null;
    const legacy = !stored && !isCustom && Date.now() < LEGACY_FALLBACK_UNTIL ? legacyVersion(body) : null;

    if (stored && isCustom) {
      version = stored;
      question = String(body.customQuestion).replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
      if (question.length < 5) throw new HttpError(400, "Ask a slightly longer question.");
      if (question.length > CUSTOM_QUESTION_MAX_CHARS) throw new HttpError(400, `Keep your question under ${CUSTOM_QUESTION_MAX_CHARS} characters.`);
      if (await bumpDailyCount(store, "custom-questions") > CUSTOM_QUESTIONS_PER_DAY) {
        throw new HttpError(429, "Today's allowance of your own questions is used up — the six threads are still open.");
      }
      const parent = Number(body.parentIndex);
      asked = { parent: Number.isInteger(parent) ? version.questions[parent]?.text || null : null };
    } else if (stored) {
      version = stored;
      const idx = Number(body.questionIndex);
      question = Number.isInteger(idx) ? version.questions[idx]?.text : null;
      if (!question) throw new HttpError(400, "Unknown question.");
    } else if (legacy) {
      ({ version, question } = legacy);
    } else if (record) {
      throw new HttpError(409, "That day's story has changed since this page loaded. Reload to see the latest.");
    } else {
      throw new HttpError(404, "No expedition was saved for that day.");
    }

    const events = await openExploration(version, question, lens, body.date, asked);
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        const send = (event) => controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
        try {
          for await (const event of events) send(event);
        } catch (err) {
          console.error("explore stream:", err);
          send({ type: "error", error: err.message });
        }
        controller.close();
      },
    });
    return new Response(stream, {
      headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" },
    });
  } catch (err) {
    if (!err.status || err.status >= 500) console.error("explore:", err);
    return json(err.status || 500, { error: err.message });
  }
};
