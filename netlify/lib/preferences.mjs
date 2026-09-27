// What the daily pick should lean toward. Edit, commit, and the next build
// (6am, or a regenerate) uses it. Plain words work best — Gemini reads these
// as guidance, not hard filters.

export const PREFERENCES = {
  // Topics to favour when two stories are otherwise close.
  // e.g. ["energy and climate", "science and research", "technology policy", "economic history"]
  interests: [],

  // Topics to steer away from unless nothing else is substantial.
  // e.g. ["US electoral horse-race politics", "celebrity business feuds"]
  avoid: [],

  // Days of recent picks to show the editor, so the same story or theme
  // doesn't win day after day. 0 turns this off.
  varietyDays: 5,
};
