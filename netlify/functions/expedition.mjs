// GET  /api/expedition?date=YYYY-MM-DD  → that day's expedition (built on first request if it's today)
// POST /api/expedition {date}            → replace today's story with a different one

import { buildExpedition, publicView, isCurrentSomewhere, DATE_RE, HttpError } from "../lib/expedition.mjs";
import { openStore, getDay, putDay, saveFirstBuild, getRecentDays } from "../lib/store.mjs";
import { PREFERENCES } from "../lib/preferences.mjs";

const MAX_REGENERATIONS = 5;
const CANDIDATE_REUSE_MS = 3 * 60 * 60 * 1000; // regenerate re-reads the news if the pool is older than this

export const config = {
  path: "/api/expedition",
  method: ["GET", "POST"],
  rateLimit: { windowLimit: 20, windowSize: 60, aggregateBy: ["ip", "domain"] },
};

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

async function getExpedition(store, dateKey) {
  const existing = await getDay(store, dateKey);
  if (existing) return existing;
  if (!isCurrentSomewhere(dateKey)) throw new HttpError(404, "No expedition was saved for that day.");

  const recent = await getRecentDays(store, dateKey, PREFERENCES.varietyDays);
  const record = await buildExpedition(dateKey, { recent });
  return saveFirstBuild(store, dateKey, { ...record, trigger: "on-demand", regenerations: 0, excluded: [], history: [] });
}

async function regenerate(store, dateKey) {
  if (!isCurrentSomewhere(dateKey)) throw new HttpError(400, "Only today's expedition can be regenerated.");

  const current = await getDay(store, dateKey);
  if (!current) return getExpedition(store, dateKey);
  if ((current.regenerations || 0) >= MAX_REGENERATIONS) {
    throw new HttpError(429, `Today's story has already been swapped ${MAX_REGENERATIONS} times — enough news for one day.`);
  }

  const pool = current.candidates;
  const poolIsFresh = pool && Date.now() - Date.parse(pool.gatheredAt) < CANDIDATE_REUSE_MS;
  const excluded = [...(current.excluded || []), current.headline];

  const recent = await getRecentDays(store, dateKey, PREFERENCES.varietyDays);
  const record = await buildExpedition(dateKey, { excluded, candidates: poolIsFresh ? pool : null, recent });

  // Keep earlier versions so explorations of an older on-screen story still resolve.
  const { candidates, history, ...previous } = current;
  const next = {
    ...record,
    trigger: "regenerate",
    regenerations: (current.regenerations || 0) + 1,
    excluded,
    history: [...(history || []), previous],
  };
  await putDay(store, dateKey, next);
  return next;
}

export default async (req, context) => {
  try {
    const store = openStore(context?.deploy?.context);
    if (req.method === "GET") {
      const dateKey = new URL(req.url).searchParams.get("date") || "";
      if (!DATE_RE.test(dateKey)) return json(400, { error: "Missing or invalid date." });
      return json(200, publicView(await getExpedition(store, dateKey)));
    }

    let body;
    try { body = await req.json(); } catch { return json(400, { error: "Invalid JSON body." }); }
    if (!DATE_RE.test(body?.date || "")) return json(400, { error: "Missing or invalid date." });
    return json(200, publicView(await regenerate(store, body.date)));
  } catch (err) {
    if (!err.status || err.status >= 500) console.error("expedition:", err);
    return json(err.status || 500, { error: err.message });
  }
};
