// One Netlify Blobs record per day, shared by every device.
// Production uses a site-wide store, so records survive deploys. Deploy
// previews and branch deploys each get a store scoped to that deploy, so
// testing (e.g. regenerating) on a preview can never touch production data.
// Strong consistency so a regenerate is visible to the very next request.

import { getDeployStore, getStore } from "@netlify/blobs";

const STORE_OPTIONS = { name: "expeditions", consistency: "strong" };
const ISOLATED_CONTEXTS = new Set(["deploy-preview", "branch-deploy"]);

// deployContext is context.deploy.context from the function's Context object
export function openStore(deployContext) {
  return ISOLATED_CONTEXTS.has(deployContext) ? getDeployStore(STORE_OPTIONS) : getStore(STORE_OPTIONS);
}

const key = (dateKey) => `day/${dateKey}`;

export function getDay(store, dateKey) {
  return store.get(key(dateKey), { type: "json" });
}

// Returns true if written. With onlyIfNew, a record someone else saved first wins.
export async function putDay(store, dateKey, record, { onlyIfNew = false } = {}) {
  const { modified } = await store.setJSON(key(dateKey), record, onlyIfNew ? { onlyIfNew: true } : {});
  return modified;
}

// Build a day if nobody has yet; if two builds race, both callers get the first one saved.
export async function saveFirstBuild(store, dateKey, record) {
  if (await putDay(store, dateKey, record, { onlyIfNew: true })) return record;
  return (await getDay(store, dateKey)) || record;
}
