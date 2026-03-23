# Manifest variants

- `manifest.json`: store-safe manifest (cloud proxy host only).
- `manifest.dev.json`: local development manifest (includes `http://localhost:8787/*`).

To switch to local-dev testing:

```powershell
Copy-Item .\extension\manifest.dev.json .\extension\manifest.json -Force
```

To switch back to store-safe build:

```powershell
git checkout -- .\extension\manifest.json
```
