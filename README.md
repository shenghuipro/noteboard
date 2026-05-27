# Noteboard

A visual whiteboard for notes, links, video transcripts, and collaborative ideas.

## Features

- **Rich card types** — Note, Link, To-do, Title, Board, Column, Table, Comment, Caption, Heading, Audio, Map, Video
- **Freehand drawing** — Sketch with natural strokes via perfect-freehand
- **Video embedding** — YouTube & Bilibili with cookie injection for logged-in playback
- **Tree view** — Navigate and organize cards in a hierarchical tree
- **Sync** — Cross-device sync via Supabase (desktop ↔ mobile web)
- **PWA** — Installable as a mobile web app with offline cache

## Desktop

```bash
npm install
npm start
```

## Web Deployment (GitHub Pages)

Deploy with Supabase sync:

1. Create a Supabase project and run [supabase/schema.sql](supabase/schema.sql)
2. Set repository variables `SUPABASE_URL` and `SUPABASE_ANON_KEY` in GitHub → Settings → Secrets and variables → Actions
3. Push to `master` — GitHub Actions builds and deploys automatically

## Tech Stack

- Electron (desktop)
- Vanilla JS + CSS (no framework)
- Supabase (sync backend)
- perfect-freehand (drawing)
- GitHub Actions + Pages (CI/CD)

## License

ISC
