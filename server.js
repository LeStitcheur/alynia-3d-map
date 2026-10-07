// Minimal static server for public/ (no dependencies). PORT env var supported for hosting platforms.
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), 'public');
const PORT = Number(process.env.PORT) || 8080;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    let path = normalize(join(ROOT, decodeURIComponent(url.pathname)));
    if (path !== ROOT && !path.startsWith(ROOT + sep)) { res.writeHead(403).end(); return; }
    let info = await stat(path).catch(() => null);
    if (info?.isDirectory()) { path = join(path, 'index.html'); info = await stat(path).catch(() => null); }
    if (!info) { res.writeHead(404, { 'Content-Type': 'text/plain' }).end('404'); return; }

    const ext = extname(path).toLowerCase();
    res.writeHead(200, {
      'Content-Type': TYPES[ext] || 'application/octet-stream',
      'Content-Length': info.size,
      // the model is big: let browsers cache it, but always revalidate code
      'Cache-Control': ext === '.glb' ? 'public, max-age=86400' : 'no-cache',
    });
    if (req.method === 'HEAD') { res.end(); return; }
    createReadStream(path).pipe(res);
  } catch (e) {
    res.writeHead(500).end(String(e));
  }
}).listen(PORT, () => console.log(`Ocean Hospital 3D → http://localhost:${PORT}`));
