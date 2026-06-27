# Driving log

A shared driving practice log for tracking supervised driving hours toward
Ohio's 50-hour learner's permit requirement (10 of which must be at night).

Built for two people (parents) to log drives from their own phones, with
all entries syncing to one shared total. Day and night classification is
based on actual sunrise and sunset for your configured home location,
not a fixed clock time.

## Features

- Start/stop live drive tracking
- Manual entry for past drives, with or without exact start/end times
- Recovery flow for a drive that was started and never stopped
- Every entry editable or deletable at any time
- Running totals (total, day, night hours) always visible
- CSV export
- Installable to a phone home screen as a bookmark (Add to Home Screen)

## Setup

This app needs a free Firebase project to store data and sync it across
devices. Static hosting (GitHub Pages) serves the files; Firebase Firestore
holds the data.

### 1. Create a Firebase project

1. Go to https://console.firebase.google.com
2. Click "Add project", give it a name (e.g. `driving-log`), and finish the
   setup wizard. You can disable Google Analytics, it isn't needed.
3. Once the project is created, in the left sidebar go to **Build > Firestore
   Database**, click **Create database**, choose a region close to you, and
   start in **production mode**.
4. After the database is created, go to the **Rules** tab and replace the
   default rules with the contents of `firestore.rules` in this repo. Click
   **Publish**.

### 2. Register a web app and get config keys

1. In the Firebase console, click the gear icon next to "Project Overview"
   and choose **Project settings**.
2. Under "Your apps", click the web icon (`</>`) to register a new web app.
   Give it any nickname. You don't need Firebase Hosting.
3. Firebase will show a config object that looks like this:

   ```js
   const firebaseConfig = {
     apiKey: "...",
     authDomain: "...",
     projectId: "...",
     storageBucket: "...",
     messagingSenderId: "...",
     appId: "..."
   };
   ```

4. Copy those values into `firebase-config.js` in this repo, replacing the
   `REPLACE_ME` placeholders.

These values are safe to commit to a public repo. They identify the
Firebase project to the client SDK; they are not secret credentials.
Access control is enforced by the Firestore rules from step 1, not by
hiding this file.

### 3. Enable GitHub Pages

1. Push this repo to GitHub.
2. In the repo on GitHub, go to **Settings > Pages**.
3. Under "Build and deployment", set Source to **GitHub Actions**.
4. Push to `main` (or merge a PR into it) and the included workflow at
   `.github/workflows/deploy.yml` will build and publish the site
   automatically. The Pages URL will appear in the Actions run summary and
   under Settings > Pages once the first deploy finishes.

### 4. Add to your phones

Open the published URL in Safari (iOS) or Chrome (Android) on each phone,
then use "Add to Home Screen" (iOS Share menu) or "Add to Home screen"
(Android browser menu) to install it as a bookmark icon.

## Data model

Firestore collections:

- `drives/{id}` — one document per completed drive entry. Fields:
  `id`, `schemaVersion`, `startTime`/`endTime` (ms timestamps, for timed
  entries) or `manualDate`/`manualMinutes`/`manualClass` (for manual
  entries), `sortTime`, `dayMinutes`, `nightMinutes`, `supervisor`,
  `supervisorName`, `notes`.
- `meta/active` — a single document holding the currently in-progress
  drive, if any. `{ empty: true }` when no drive is active.

`schemaVersion` exists so that future structural changes to the entry
shape can be migrated in code (see `migrateEntry` in `app.js`) rather than
breaking or discarding old entries.

## Local development

No build step. Any static file server works, for example:

```
npx serve .
```

Then open the printed local URL in a browser.
