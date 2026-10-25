// Proxy opcional para Cloudflare Pages. No GitHub Pages este arquivo é ignorado e o
// navegador lê o TSE direto (o TSE devolve Access-Control-Allow-Origin com a origem pedida).
// Se um dia o site for para o Cloudflare, o cache de borda junta os visitantes numa
// leitura ao TSE a cada poucos segundos.
const ORIGEM = 'https://resultados.tse.jus.br/oficial/';
const PADRAO = /^[a-z0-9_\-/.]+\.json$/i;

export async function onRequestGet({ params, request, waitUntil }) {
  const caminho = Array.isArray(params.path) ? params.path.join('/') : String(params.path || '');
  if (!PADRAO.test(caminho) || caminho.includes('..')) {
    return resposta(JSON.stringify({ erro: 'caminho inválido' }), 400, 60);
  }
  const chave = new Request(new URL('/tse/' + caminho, request.url).toString(), { method: 'GET' });
  const cache = caches.default;
  const guardada = await cache.match(chave);
  if (guardada) return guardada;

  let r;
  try {
    r = await fetch(ORIGEM + caminho, { cf: { cacheTtl: 0 }, headers: { accept: 'application/json' } });
  } catch (e) {
    return resposta(JSON.stringify({ erro: 'falha ao ler o TSE' }), 502, 5);
  }
  // O TSE responde 404 com XML do S3; devolvemos um JSON nosso para o front reconhecer.
  const ok = r.status === 200;
  const corpo = ok ? await r.text() : JSON.stringify({ erro: 'nao publicado', status: r.status });
  const ttl = ok ? 15 : 5;
  const saida = resposta(corpo, ok ? 200 : r.status, ttl);
  waitUntil(cache.put(chave, saida.clone()));
  return saida;
}

function resposta(corpo, status, ttl) {
  return new Response(corpo, {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': `public, max-age=${ttl}`,
      'x-apuracao-proxy': '1',
      'access-control-allow-origin': '*',
    },
  });
}
