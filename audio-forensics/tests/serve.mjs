import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
const root = process.cwd();
const mime = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.json':'application/json', '.wav':'audio/wav', '.mp3':'audio/mpeg' };
createServer(async (req, res) => {
  try {
    const p = normalize(join(root, req.url.split('?')[0] === '/' ? '/index.html' : req.url.split('?')[0]));
    if (!p.startsWith(root)) { res.writeHead(403); return res.end(); }
    const data = await readFile(p);
    res.writeHead(200, { 'content-type': mime[extname(p)] || 'application/octet-stream' });
    res.end(data);
  } catch { res.writeHead(404); res.end('not found'); }
}).listen(8731, () => console.log('http://127.0.0.1:8731'));
