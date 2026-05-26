# Save Bot (Telegram + Node.js + JSON)

This bot accepts social media links and returns downloadable media files in Telegram.

## Features

- Works with many platforms supported by `yt-dlp` (YouTube, Instagram, Facebook, and others)
- Automatic media type detection (photo, video, document)
- JSON file storage for users, jobs, cache, and ads (`data/data.json`)
- Cache by source URL to return already processed files faster
- Download concurrency control

## Requirements

- Node.js 20+
- `yt-dlp` installed on server
- `ffmpeg` installed on server

On macOS:

```bash
brew install yt-dlp ffmpeg
```

## Setup

1. Install dependencies:

```bash
npm install
```

2. Create environment file:

```bash
cp .env.example .env
```

3. Fill `.env` values:

- `TELEGRAM_BOT_TOKEN` your bot token (recommended: regenerate token in BotFather first)
- `ADMIN_IDS` your Telegram user id(s)

4. Start development:

```bash
npm run dev
```

5. Start production:

```bash
npm start
```

## Security note

If your token was shared publicly, regenerate it in BotFather using `/revoke`.

## Project structure

- `src/index.js` app entrypoint
- `src/bot/handlers.js` Telegram handlers and main flow
- `src/services/downloader.js` yt-dlp integration and file lifecycle
- `src/models` JSON-backed data access
- `data/data.json` local database file (auto-created)
- `src/utils/url.js` URL extraction and platform detection

## Behavior

- User sends URL in chat
- Bot validates URL and creates a queued job in MongoDB
- Bot downloads media with yt-dlp
- Bot sends media file back to user
- Bot caches Telegram file id to speed up repeated links

## Limitations

- Telegram Bot API file size limits apply
- Private or restricted posts may fail without authorization
- Some platform changes may require yt-dlp updates

## Legal and compliance

Use this bot only for content you own or have rights to download.
