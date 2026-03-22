# Sunbird Wikipedia Translator Extension

This project contains:

- `extension/`: Chrome/Edge MV3 extension that translates visible Wikipedia article text to Runyankore.
- `proxy/`: Node proxy that calls Sunbird API securely (keeps token out of extension code).

## Proxy Setup (Local Node)

From `proxy/`:

```bash
npm install
cp .env.example .env
npm start
```

Health check:

```bash
curl http://localhost:8787/health
```

## Docker Compose (GitHub Build Context)

This compose file builds from GitHub directly (`main:proxy`) and tags image as `oasis256/sunbird-proxy:latest`.

1. Create a local `.env` in the same folder as `docker-compose.yml`:

```env
SUNBIRD_BASE_URL=https://api.sunbird.ai
SUNBIRD_TOKEN=your-token
SUNBIRD_TRANSLATE_ENDPOINTS=/tasks/translate
PORT=8787
TRANSLATE_CONCURRENCY=6
SUNBIRD_REQUEST_TIMEOUT_MS=20000
SUNBIRD_RETRY_COUNT=1
```

2. Build and run:

```bash
docker compose up -d --build
```

3. Logs:

```bash
docker compose logs -f sunbird-proxy
```

4. Stop:

```bash
docker compose down
```

## Load Extension

1. Open `chrome://extensions` or `edge://extensions`.
2. Enable Developer mode.
3. Click **Load unpacked**.
4. Select `sunbird-page-translator/extension`.

## Use It

1. Open an English Wikipedia article.
2. Click extension icon.
3. Click **Translate Page**.
4. Click **Restore** to revert page changes.
5. Click **Copy Wikitext** to copy translated source.


