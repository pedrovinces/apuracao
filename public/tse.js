// Leitura dos arquivos públicos de divulgação do TSE.
// Ordem: proxy do próprio site (tse/<caminho>, existe só no Cloudflare Pages) e, se ele
// não existir, o servidor do TSE direto. A escolha fica memorizada para não pagar
// duas requisições por arquivo durante a noite inteira.
export const BASE_TSE = 'https://resultados.tse.jus.br/oficial/';
export const diagnostico = [];
const LIMITE_DIAG = 300;

let modo = null; // 'proxy' | 'direto' | null (ainda não testado)
let fonteDemo = null; // função (caminho) => {status, dados}, ligada pelo modo demonstração

export function usarDemo(fn) { fonteDemo = fn; }
export function modoAtual() { return fonteDemo ? 'demo' : modo || 'detectando'; }

function registrar(caminho, status, origem, ms) {
  diagnostico.unshift({ hora: new Date(), caminho, status, origem, ms });
  if (diagnostico.length > LIMITE_DIAG) diagnostico.length = LIMITE_DIAG;
}

// A CDN do TSE ignora parâmetros (verificado: mesma resposta para valores diferentes), então
// o carimbo não fura o cache dela; serve para caches intermediários entre o visitante e o TSE.
const carimbo = () => Math.floor(Date.now() / 10000);

async function lerProxy(caminho) {
  const r = await fetch('tse/' + caminho, { cache: 'no-store' });
  const tipo = r.headers.get('content-type') || '';
  if (!r.headers.get('x-apuracao-proxy') && !tipo.includes('json')) return null; // sem função
  if (r.status !== 200) return { status: r.status, dados: null };
  try { return { status: 200, dados: await r.json() }; } catch { return null; }
}

async function lerDireto(caminho) {
  const r = await fetch(BASE_TSE + caminho + '?t=' + carimbo(), { cache: 'no-store' });
  if (r.status !== 200) return { status: r.status, dados: null };
  try { return { status: 200, dados: await r.json() }; } catch { return { status: 'json-invalido', dados: null }; }
}

// Devolve sempre {status, dados}; nunca lança, para o painel não quebrar por um arquivo.
export async function lerJSON(caminho) {
  const t0 = performance.now();
  const fim = (res, origem) => { registrar(caminho, res.status, origem, Math.round(performance.now() - t0)); return res; };
  if (fonteDemo) return fim(await fonteDemo(caminho), 'demo');
  try {
    if (modo !== 'direto') {
      let res = null;
      try { res = await lerProxy(caminho); } catch { res = null; }
      if (res) { modo = 'proxy'; return fim(res, 'proxy'); }
      modo = 'direto';
    }
    return fim(await lerDireto(caminho), 'direto');
  } catch (e) {
    return fim({ status: 'erro de rede', dados: null }, modo || 'direto');
  }
}
