# Medication Tracker (Ionic + Angular)

This folder contains the migrated Ionic/Angular version of the original React PWA.

## Why this migration

The app now uses Angular Service Worker update events (`SwUpdate`) for a more predictable update banner flow, including iOS fallback guidance when update activation is delayed.

## Run locally

```bash
npm install
npm start
```

## Production build

```bash
npm run build
```

Build output goes to `www/`.

## Key migrated features

- Today / Manage / History tabs
- Medication schedule CRUD
- Taken / skipped logging
- 30-day history summary
- Reminder beeps + notification reminders
- JSON backup export/import
- Install prompt banner (Android/Chrome)
- Update available banner using Angular `SwUpdate`

## Data compatibility

The Ionic/Angular app uses the same localStorage keys as the React app:

- `medtracker:medications`
- `medtracker:logs`
- `medtracker:reminderBeeps`
- `medtracker:notificationsEnabled`

This means existing browser data and backup JSON files remain compatible.
