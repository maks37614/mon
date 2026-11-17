#!/usr/bin/env python3
"""Patch only the isolated November 8 backup, never the production h00k checkout."""
import json
import pathlib
import sys

root = pathlib.Path(sys.argv[1]).resolve()
if not (root / "server.ts").is_file() or not (root / "index.html").is_file():
    raise SystemExit("Refusing to patch: invalid old-site root")

def replace_once(path: pathlib.Path, before: str, after: str) -> None:
    source = path.read_text(encoding="utf-8")
    if source.count(before) != 1:
        raise SystemExit(f"Unsafe patch: expected one match in {path}, got {source.count(before)}")
    path.write_text(source.replace(before, after, 1), encoding="utf-8")

middleware = """
  // Isolated, read-only historical preview: reject all writes and private APIs.
  const oldPreviewPaths = new Set([
    '/health', '/screener/scan', '/screener/coins', '/market/quotes',
    '/market/sentiment', '/klines', '/chart/trades24h',
    '/derivatives/oi', '/derivatives/oi/history'
  ]);
  const oldPreviewHits = new Map<string, { startedAt: number; count: number }>();
  app.use('/api', (req, res, next) => {
    if (!['GET', 'HEAD'].includes(req.method) || !oldPreviewPaths.has(req.path)) {
      res.status(403).json({ error: 'Old preview: API disabled' });
      return;
    }
    const bucket = req.path === '/screener/scan' ? 'scan' : 'market';
    const limit = bucket === 'scan' ? 8 : 100;
    const now = Date.now();
    let hits = oldPreviewHits.get(bucket);
    if (!hits || now - hits.startedAt >= 60_000) {
      hits = { startedAt: now, count: 0 };
      oldPreviewHits.set(bucket, hits);
    }
    if (hits.count >= limit) {
      res.setHeader('Retry-After', '30');
      res.status(429).json({ error: 'Old preview rate limit' });
      return;
    }
    hits.count++;
    next();
  });
"""
server = root / "server.ts"
replace_once(server, "  app.use(express.json());\n", "  app.use(express.json());\n" + middleware)
original = server.read_text(encoding="utf-8")
start = "  const httpServer = app.listen(PORT, '0.0.0.0', () => {"
end = "  installHookChartDepthStream(httpServer);"
if original.count(start) != 1 or original.count(end) != 1:
    raise SystemExit("Unsafe patch: background-task block has changed")
a = original.index(start)
b = original.index(end, a) + len(end)
replacement = """  // Deliberately no CRON, Telegram bot, notification worker or live depth stream.
  app.listen(PORT, '0.0.0.0', () => {
    console.log('OLD h00k visual preview listening on port ' + PORT);
  });"""
server.write_text(original[:a] + replacement + original[b:], encoding="utf-8")

replace_once(
    root / "index.html",
    "    <title>h00k.top</title>",
    '    <meta name="robots" content="noindex, nofollow, noarchive" />\n    <title>h00k — historical preview</title>'
)
replace_once(
    root / "src/firebase.ts",
    "if (typeof window !== 'undefined') void testConnection();",
    "// Disabled: no Firebase connection on startup in historical preview."
)
config = root / "firebase-applet-config.json"
config.write_text(json.dumps({
    "projectId": "h00k-old-stage-disabled",
    "appId": "1:000000000000:web:0000000000000000000000",
    "apiKey": "offline-stage-placeholder",
    "authDomain": "h00k-old-stage.invalid",
    "firestoreDatabaseId": "(default)",
    "storageBucket": "h00k-old-stage.invalid",
    "messagingSenderId": "000000000000",
    "measurementId": "",
    "oAuthClientId": "",
    "recaptchaSiteKey": ""
}, indent=2) + "\n", encoding="utf-8")
print("Isolated old site patched: no background tasks, no Firebase, read-only public GET API")
