// Servidor estático mínimo para testar localmente (sem a função de proxy: o front cai
// automaticamente na leitura direta do TSE, como acontece no GitHub Pages).
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const raiz = process.env.RAIZ || new URL('../public/', import.meta.url).pathname;
const tipos = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.png': 'image/png' };
const porta = Number(process.env.PORT || 8080);

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  let caminho = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
  if (caminho.endsWith('/')) caminho += 'index.html';
  try {
    const corpo = await readFile(join(raiz, caminho));
    res.writeHead(200, { 'content-type': tipos[extname(caminho)] || 'application/octet-stream' });
    res.end(corpo);
  } catch {
    res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<h1>404</h1>');
  }
}).listen(porta, () => console.log(`http://localhost:${porta}/`));
