// Proxy mínimo: supabase-js llama a <url>/rest/v1/...; PostgREST sirve en la raíz.
import http from 'node:http';
const [listen, target] = process.argv.slice(2).map(Number);
http.createServer((req, res) => {
  const path = (req.url ?? '/').replace(/^\/rest\/v1/, '') || '/';
  const up = http.request({ host: '127.0.0.1', port: target, path, method: req.method, headers: { ...req.headers, host: `127.0.0.1:${target}` } }, (r) => {
    res.writeHead(r.statusCode ?? 502, r.headers);
    r.pipe(res);
  });
  up.on('error', (e) => { res.writeHead(502); res.end(String(e)); });
  req.pipe(up);
}).listen(listen, '127.0.0.1');
