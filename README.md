# Sunbird Wikipedia Translator Extension

This project contains:

- `extension/`: Chrome/Edge MV3 extension that translates visible Wikipedia article text to Runyankore.
- `proxy/`: Node proxy that calls Sunbird API securely (keeps token out of extension code).

## 1) Proxy Setup (Local Node)

From `proxy/`:

```bash
npm install
```

Copy env file:

```bash
cp .env.example .env
```

Edit `.env` and set:

- `SUNBIRD_TOKEN`
- optionally `SUNBIRD_TRANSLATE_ENDPOINTS` if your account uses a specific translation route.

Start proxy:

```bash
npm start
```

Proxy will run at `http://localhost:8787`.

Health check:

```bash
curl http://localhost:8787/health
```

## 2) Proxy Setup (Docker)

From project root (`sunbird-page-translator/`):

1. Create `proxy/.env` from `proxy/.env.example` and set `SUNBIRD_TOKEN`.
2. Build and run:

```bash
docker compose up -d --build
```

3. Check logs:

```bash
docker compose logs -f sunbird-proxy
```

4. Health check:

```bash
curl http://localhost:8787/health
```

5. Stop:

```bash
docker compose down
```

You can also build/run without compose:

```bash
docker build -t sunbird-proxy ./proxy
docker run --rm -p 8787:8787 --env-file ./proxy/.env sunbird-proxy
```

## 3) Load Extension

1. Open Chrome/Edge and go to `chrome://extensions` or `edge://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select `sunbird-page-translator/extension`.

## 4) Use It

1. Open an English Wikipedia article.
2. Click extension icon.
3. Click **Translate Page**.
4. Click **Restore** to revert translated text nodes.
5. Click **Copy Wikitext** to copy translated source.

## Notes

- Translation target is currently fixed to Runyankore (`nyn`).
- The extension expects proxy at `http://localhost:8787`.
- If translation fails, check proxy logs and verify endpoint/token validity.

## Endpoint Flexibility

The proxy tries each endpoint in order from `SUNBIRD_TRANSLATE_ENDPOINTS`.
Default:

- `/tasks/nllb_translate`
- `/tasks/translate`
- `/tasks/translation`

If your Sunbird tenant has a different translation endpoint or payload schema, update `proxy/server.js` in `makePayload()` and `extractTextFromResult()`.
