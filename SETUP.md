# The Daily Expedition — Setup Guide

## What you need before you start
- Your Gemini API key (starts with AIza...)
- Your Currents API key (from currentsapi.services dashboard)
- A free Netlify account (netlify.com)
 
---

## Step 1 — Download and prepare the project

You should have received a folder called `daily-expedition`.
It contains:
```
daily-expedition/
  index.html
  netlify.toml
  netlify/
    functions/
      news.js
      generate.js
```

Do not rename or move any of these files. The folder structure matters.

---

## Step 2 — Deploy to Netlify

1. Go to https://app.netlify.com and log in
2. On your dashboard, look for a box that says **"Deploy manually"** or **"Want to deploy a new site without connecting to Git?"**
3. It will say: **"Drag and drop your site folder here"**
4. Drag the entire `daily-expedition` folder onto that box
5. Wait about 30 seconds — Netlify will give you a URL like `https://whimsical-fox-abc123.netlify.app`

That URL is your app. But it won't work yet — you need to add your API keys.

---

## Step 3 — Add your API keys

This is the most important step. Your API keys are never in the code files — they live securely in Netlify's dashboard.

1. In Netlify, click on your newly deployed site
2. Go to **Site configuration** → **Environment variables**
3. Click **Add a variable** and add these two, exactly as written:

| Key name            | Value                        |
|---------------------|------------------------------|
| `GEMINI_API_KEY`    | your Gemini key (AIza...)    |
| `CURRENTS_API_KEY`  | your Currents API key        |

4. After adding both, go to **Deploys** and click **Trigger deploy → Deploy site**
   (This restarts the site so it picks up your new keys)

---

## Step 4 — Open on your phone

1. Open your Netlify URL in Safari (iPhone) or Chrome (Android)
2. **iPhone**: tap the Share button → "Add to Home Screen" → Add
3. **Android**: tap the three-dot menu → "Add to Home Screen"

The app will now appear on your home screen like a native app.

---

## Using the app

- Open it once a day, ideally in the morning
- The doorway loads automatically — one real story from today's world
- Tap any of the six questions to go deep
- At the bottom of each exploration, try a different lens (Historical roots, Economic lens, etc.)
- Each session takes about 15–20 minutes

---

## Troubleshooting

**"The expedition couldn't load"**
→ Check that both environment variables are set correctly in Netlify
→ Go to Deploys → Trigger deploy after setting them

**The page loads but shows an error about the news API**
→ Check your CURRENTS_API_KEY is correct (copy it fresh from your Currents dashboard)

**Gemini returns an error**
→ Make sure your GEMINI_API_KEY is active in Google AI Studio (aistudio.google.com)
→ Check you haven't exceeded the free tier rate limit (very unlikely for daily personal use)

**The app looks broken on phone**
→ Make sure you're using Safari on iPhone or Chrome on Android
→ Try a hard refresh (pull down on the page)

---

## Cost

Running this daily costs nothing:
- Currents API free tier: 600 requests/day — you use ~2 per session
- Gemini free tier: generous daily quota — you use ~3 calls per session  
- Netlify free tier: more than enough for a personal site

---

## Updating the app in future

If you ever want to update the app (e.g. Claude gives you a new version):
1. Replace the files in the `daily-expedition` folder with the new ones
2. Drag the folder onto Netlify again
3. It will deploy the new version automatically

Your API keys stay saved in Netlify — you never need to re-enter them.
