// Builds each morning's expedition before anyone opens the app.
// 10:00 UTC = 6am Eastern in summer, 5am in winter. Only runs on the published deploy.

import { buildExpedition, localDateKey } from "../lib/expedition.mjs";
import { getDay, saveFirstBuild } from "../lib/store.mjs";

export const config = { schedule: "0 10 * * *" };

export default async () => {
  const dateKey = localDateKey(process.env.EXPEDITION_TZ || "America/New_York");

  if (await getDay(dateKey)) {
    console.log(`daily-build: ${dateKey} already exists, skipping`);
    return;
  }

  const record = await buildExpedition(dateKey);
  await saveFirstBuild(dateKey, { ...record, trigger: "schedule", regenerations: 0, excluded: [], history: [] });
  console.log(`daily-build: ${dateKey} → "${record.headline}"`, record.candidates.report);
};
