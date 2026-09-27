// Builds each morning's expedition before anyone opens the app.
// 10:00 UTC = 6am Eastern in summer, 5am in winter. Only runs on the published deploy.

import { buildExpedition, localDateKey } from "../lib/expedition.mjs";
import { openStore, getDay, saveFirstBuild, getRecentDays } from "../lib/store.mjs";
import { PREFERENCES } from "../lib/preferences.mjs";

export const config = { schedule: "0 10 * * *" };

export default async () => {
  const dateKey = localDateKey(process.env.EXPEDITION_TZ || "America/New_York");
  const store = openStore("production"); // schedules only run on the published production deploy

  if (await getDay(store, dateKey)) {
    console.log(`daily-build: ${dateKey} already exists, skipping`);
    return;
  }

  const recent = await getRecentDays(store, dateKey, PREFERENCES.varietyDays);
  const record = await buildExpedition(dateKey, { recent });
  await saveFirstBuild(store, dateKey, { ...record, trigger: "schedule", regenerations: 0, excluded: [], history: [] });
  console.log(`daily-build: ${dateKey} → "${record.headline}"`, record.candidates.report);
};
