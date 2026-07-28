# Court Watch

A live, crowdsourced "is the court free?" board for Courts 1–3, built with Vite + React.
Court 2 & 3 use free-text Free/Busy reports shared in real time via Firebase.
Court 1 links out to Varaamo for reservations.

## 1. Create a free Firebase project

1. Go to https://console.firebase.google.com and create a project (free tier is enough).
2. In the left sidebar: **Build → Realtime Database → Create Database**. Pick any location,
   start in test mode (we'll replace the rules below).
3. Go to **Project settings** (gear icon, top left) → **General** → scroll to **"Your apps"**
   → click the web icon `</>` → register an app (no need for Firebase Hosting).
4. Copy the `firebaseConfig` object it shows you.

## 2. Add your config

Open `src/firebase.js` and replace every `'REPLACE_ME'` value with the matching value from
the config you just copied.

## 3. Set the database rules

This app has no login system — anyone with the link can read and write, matching the
"no accounts, crowdsourced, trust-based" design of the app itself. In the Firebase console:
**Realtime Database → Rules**, replace the contents with:

```json
{
  "rules": {
    ".read": true,
    ".write": true
  }
}
```

Click **Publish**. (Test-mode rules expire after 30 days — this replaces that with permanently
open rules. Anyone who has your Firebase config could technically write arbitrary data, not
just via the app's UI. That's an acceptable tradeoff for a small community court board, but
worth knowing.)

## 4. Run it locally

```bash
npm install
npm run dev
```

Open the URL it prints. Open it in a second tab/device too, tap Busy on one, and confirm it
shows up on the other within a second or two — that confirms the live sync is working.

## 5. Deploy to Vercel

1. Push this folder to a GitHub repo.
2. Go to https://vercel.com → **Add New → Project** → import that repo.
3. Vercel auto-detects Vite — leave the defaults (Build command `vite build`, Output
   directory `dist`) and click **Deploy**.
4. Once deployed, open the Vercel URL on two devices and repeat the same live-sync test
   from step 4 before sharing it with real players.

## Notes

- Courts 2 & 3's data (reports, current status, schedule) lives in Firebase, shared live
  across every visitor — no polling delay, updates push instantly.
- Every night, the app moves the previous day's reports out of the "live" data into a
  permanent dated archive (`archive/<court>/<date>` in the database) — nothing is ever
  deleted, just moved out of the way so the live data stays small.
- Court 1 is informational only (links to Varaamo) and isn't tracked in Firebase.
