# Medication Tracker

**Medication Tracker** is een **Progressive Web App (PWA)** waarmee je eenvoudig je medicatie kunt bijhouden: welke medicijnen je gebruikt, op welke tijden, of je een dosis hebt **genomen of overgeslagen**, en je **voorraad**. De app is bedoeld om op telefoon, tablet of desktop in de browser te draaien; je kunt de PWA ook **toevoegen aan je startscherm** voor app-achtig gebruik.

Na het openen zie je kort een **landingscherm** (merk / afbeelding), daarna ga je automatisch verder naar het hoofdscherm.

## Technisch

- **Ionic** + **Angular** (web)
- **Service worker** voor offline gebruik en update-meldingen
- Lokaal opgeslagen data (o.a. via `localStorage`), met export/import van een **JSON-backup**

---

Dit project bevat de gemigreerde Ionic/Angular-versie van de oorspronkelijke React-PWA.

## Waarom deze migratie

De app gebruikt nu Angular Service Worker-update-events (`SwUpdate`) voor voorspelbare update-bannerflow, inclusief iOS-fallback wanneer het activeren van een update vertraagd is.

## Lokaal draaien

```bash
npm install
npm start
```

## Productie-build

```bash
npm run build
```

Build-output staat in `www/`.

## Belangrijkste functies

- Tabs: **Vandaag** / **Beheren** / **Geschiedenis**
- Medicatie en schema’s beheren (CRUD)
- Loggen: genomen / overgeslagen
- Geschiedenis (o.a. samenvatting over meerdere dagen)
- Herinneringen (geluid + optioneel notificaties)
- JSON-backup exporteren en importeren
- Installatie-banner (Android/Chrome)
- Banner “update beschikbaar” via Angular `SwUpdate`

## Datacompatibiliteit

De Ionic/Angular-app gebruikt dezelfde `localStorage`-sleutels als de React-app:

- `medtracker:medications`
- `medtracker:logs`
- `medtracker:reminderBeeps`
- `medtracker:notificationsEnabled`

Bestaande browserdata en backup-JSON blijven daarmee compatibel.
