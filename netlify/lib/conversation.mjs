// "The conversation" around the chosen story: what people on Bluesky and
// Hacker News are saying, captured once when the day is built. All free:
// Bluesky trend feeds and HN need no login. Bluesky post *search* does, so it
// only runs when a (free) app password is configured.
//
// Posts are public, but we still honour authors who opted out of being shown
// to logged-out viewers, and skip anything labelled adult or graphic.

import { cleanText } from "./sources.mjs";

const USER_AGENT = "DailyExpedition/1.0 (+https://github.com/saarthakg/daily-expedition)";
const TIMEOUT_MS = 8000;
const POST_LIMIT = 12;
const COMMENT_LIMIT = 8;
const HIDDEN_LABELS = new Set(["!no-unauthenticated", "porn", "sexual", "nudity", "graphic-media", "gore", "!hide", "!warn"]);

async function getJson(url, headers = {}) {
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT, ...headers }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function clip(s, max) {
  return s.length > max ? s.slice(0, max - 1).trimEnd() + "…" : s;
}

// ---- Bluesky ----

function isShowable(post) {
  const labels = [...(post.labels || []), ...(post.author?.labels || [])].map((l) => l.val);
  return !labels.some((v) => HIDDEN_LABELS.has(v)) && !!post.record?.text?.trim();
}

function toPost(post) {
  const rkey = post.uri.split("/").pop();
  return {
    author: post.author.displayName?.trim() || post.author.handle,
    handle: post.author.handle,
    text: clip(post.record.text.replace(/\s+/g, " ").trim(), 300),
    likes: post.likeCount || 0,
    reposts: post.repostCount || 0,
    url: `https://bsky.app/profile/${post.author.handle}/post/${rkey}`,
    createdAt: post.record.createdAt || post.indexedAt || "",
  };
}

function topPosts(posts) {
  const seen = new Set();
  return posts
    .filter(isShowable)
    .map(toPost)
    .filter((p) => (seen.has(p.text) ? false : seen.add(p.text)))
    .sort((a, b) => b.likes + 2 * b.reposts - (a.likes + 2 * a.reposts))
    .slice(0, POST_LIMIT);
}

// A trend's link looks like /profile/<did>/feed/<rkey>, a feed generator anyone can read.
export async function fetchTrendPosts(trendUrl) {
  const m = String(trendUrl || "").match(/\/profile\/(did:[^/]+)\/feed\/([^/?#]+)/);
  if (!m) return [];
  const feed = `at://${m[1]}/app.bsky.feed.generator/${m[2]}`;
  const data = await getJson(`https://public.api.bsky.app/xrpc/app.bsky.feed.getFeed?feed=${encodeURIComponent(feed)}&limit=50`);
  return topPosts((data.feed || []).map((f) => f.post));
}

// Optional: needs BSKY_HANDLE + BSKY_APP_PASSWORD (a free app password from Bluesky settings).
export async function searchBlueskyPosts(query, { handle, appPassword }) {
  if (!query || !handle || !appPassword) return [];
  const session = await fetch("https://bsky.social/xrpc/com.atproto.server.createSession", {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": USER_AGENT },
    body: JSON.stringify({ identifier: handle, password: appPassword }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!session.ok) throw new Error(`Bluesky login failed (HTTP ${session.status})`);
  const { accessJwt } = await session.json();

  const since = new Date(Date.now() - 2 * 86400000).toISOString();
  const params = new URLSearchParams({ q: query, sort: "top", lang: "en", since, limit: "50" });
  const data = await getJson(`https://bsky.social/xrpc/app.bsky.feed.searchPosts?${params}`, {
    Authorization: `Bearer ${accessJwt}`,
  });
  return topPosts(data.posts || []);
}

// ---- Hacker News (official API lists comments in ranked order) ----

export async function fetchHnComments(discussionUrl) {
  const id = String(discussionUrl || "").match(/[?&]id=(\d+)/)?.[1];
  if (!id) return [];
  const story = await getJson(`https://hacker-news.firebaseio.com/v0/item/${id}.json`);
  const kids = (story?.kids || []).slice(0, COMMENT_LIMIT * 2);
  const comments = await Promise.all(kids.map((k) =>
    getJson(`https://hacker-news.firebaseio.com/v0/item/${k}.json`).catch(() => null)
  ));
  return comments
    .filter((c) => c && !c.deleted && !c.dead && c.text)
    .slice(0, COMMENT_LIMIT)
    .map((c) => ({
      author: c.by,
      text: clip(cleanText(c.text), 400),
      url: `https://news.ycombinator.com/item?id=${c.id}`,
    }));
}

// ---- Gather for the chosen story ----

export async function gatherConversation(signals, searchQuery) {
  const report = {};
  const attempt = async (name, fn) => {
    try {
      const result = await fn();
      report[name] = `ok (${result.length})`;
      return result;
    } catch (err) {
      report[name] = `failed: ${err.message}`;
      return [];
    }
  };

  const trend = signals?.bluesky?.[0] || null;
  const hn = signals?.hackerNews || null;
  const credentials = { handle: process.env.BSKY_HANDLE, appPassword: process.env.BSKY_APP_PASSWORD };

  const [trendPosts, searchPosts, hnComments] = await Promise.all([
    trend ? attempt("Bluesky trend feed", () => fetchTrendPosts(trend.url)) : [],
    credentials.handle && credentials.appPassword && searchQuery
      ? attempt("Bluesky search", () => searchBlueskyPosts(searchQuery, credentials))
      : [],
    hn ? attempt("Hacker News comments", () => fetchHnComments(hn.url)) : [],
  ]);

  // Trend posts first (they're certainly on-topic), then search results
  const seen = new Set();
  const posts = [...trendPosts, ...searchPosts]
    .filter((p) => (seen.has(p.url) ? false : seen.add(p.url)))
    .slice(0, POST_LIMIT);

  return {
    capturedAt: new Date().toISOString(),
    searchQuery: searchQuery || null,
    bluesky: posts,
    hackerNews: hnComments,
    report,
  };
}
