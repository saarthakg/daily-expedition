// One Netlify Blobs record per day, shared by every device.
// Site-wide store, so records survive deploys. Strong consistency so a
// regenerate is visible to the very next request.

import { getStore } from "@netlify/blobs";

const store = () => getStore({ name: "expeditions", consistency: "strong" });
const key = (dateKey) => `day/${dateKey}`;

export function getDay(dateKey) {
  return store().get(key(dateKey), { type: "json" });
}

// Returns true if written. With onlyIfNew, a record someone else saved first wins.
export async function putDay(dateKey, record, { onlyIfNew = false } = {}) {
  const { modified } = await store().setJSON(key(dateKey), record, onlyIfNew ? { onlyIfNew: true } : {});
  return modified;
}

// Build a day if nobody has yet; if two builds race, both callers get the first one saved.
export async function saveFirstBuild(dateKey, record) {
  if (await putDay(dateKey, record, { onlyIfNew: true })) return record;
  return (await getDay(dateKey)) || record;
}
