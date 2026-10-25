// Interpretação dos arquivos do TSE. O formato muda entre eleições, então os campos são
// procurados pelo nome em qualquer nível do JSON, e não por uma posição fixa.
import { lerJSON } from './tse.js?v=dev';

// Números do TSE vêm como texto, com vírgula decimal ("47,03").
export function num(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  let s = String(v).trim();
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.'); // "1.234,56" -> "1234.56"
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

export const pad6 = (cd) => String(cd).padStart(6, '0');

// Busca em largura: o nível mais raso ganha. Chaves dentro de candidatos ("cand", "vs")
// são puladas, porque lá "e", "n" e "st" significam outra coisa.
const PULAR = new Set(['cand', 'vs', 'fed', 'mnae']);
export function achar(obj, chave, aceita = (v) => v != null && typeof v !== 'object') {
  const fila = [obj];
  while (fila.length) {
    const o = fila.shift();
    if (!o || typeof o !== 'object') continue;
    if (!Array.isArray(o) && Object.prototype.hasOwnProperty.call(o, chave) && aceita(o[chave])) return o[chave];
    for (const [k, v] of Object.entries(o)) if (v && typeof v === 'object' && !PULAR.has(k)) fila.push(v);
  }
  return undefined;
}

// Junta todos os candidatos, onde quer que estejam (cand[] na raiz em 2022,
// carg[].agr[].par[].cand[] em 2026), guardando a sigla do partido mais próximo.
function coletarCandidatos(obj, sigla = null, saida = []) {
  if (Array.isArray(obj)) { obj.forEach((o) => coletarCandidatos(o, sigla, saida)); return saida; }
  if (!obj || typeof obj !== 'object') return saida;
  const siglaAqui = Array.isArray(obj.cand) && typeof obj.sg === 'string' ? obj.sg : sigla;
  if (Array.isArray(obj.cand)) {
    for (const c of obj.cand) {
      if (!c || c.n == null) continue;
      saida.push({ c, sigla: c.sgp || c.cc || siglaAqui });
    }
  }
  for (const [k, v] of Object.entries(obj)) if (k !== 'cand' && v && typeof v === 'object') coletarCandidatos(v, siglaAqui, saida);
  return saida;
}

function eleito(c) {
  const st = typeof c.st === 'string' ? c.st.normalize('NFD').replace(/[̀-ͯ]/g, '').trim() : '';
  // Em 2026 o 1º colocado do 1º turno traz e="s" e st="2º turno"; por isso st manda quando existe.
  if (st) return /^eleito/i.test(st);
  return c.e === 's' || c.e === true;
}

// Converte um arquivo de resultado (br, UF ou município) num objeto simples.
export function interpretar(dados) {
  if (!dados || typeof dados !== 'object') return null;
  const vistos = new Map();
  for (const { c, sigla } of coletarCandidatos(dados)) {
    const n = String(c.n);
    if (vistos.has(n)) continue;
    vistos.set(n, {
      n,
      nome: c.nmu || c.nm || n,
      nomeCompleto: c.nm || c.nmu || n,
      sigla: sigla || null,
      votos: num(c.vap) ?? 0,
      pct: num(c.pvapn) ?? num(c.pvap) ?? 0,
      eleito: eleito(c),
    });
  }
  const cand = [...vistos.values()];
  const totalCand = cand.reduce((s, c) => s + c.votos, 0);
  // Recalcula % quando o arquivo traz 0 mas há votos (acontece em parciais muito iniciais).
  if (totalCand > 0) for (const c of cand) if (!c.pct) c.pct = (100 * c.votos) / totalCand;
  cand.sort((a, b) => b.votos - a.votos || Number(a.n) - Number(b.n));

  const eleitorado = achar(dados, 'e', (v) => v && typeof v === 'object' && !Array.isArray(v));
  const v = achar(dados, 'v', (x) => x && typeof x === 'object' && !Array.isArray(x)) || dados;
  const eleitores = num(achar(dados, 'te')) ?? (typeof dados.e !== 'object' ? num(dados.e) : null);
  const md = achar(dados, 'md');
  return {
    cand,
    totalCand,
    pst: num(achar(dados, 'pstn')) ?? num(achar(dados, 'pst')) ?? 0,
    idg: achar(dados, 'idg') || null,
    dg: achar(dados, 'dg') || null,
    hg: achar(dados, 'hg') || null,
    eleitores,
    validos: num(achar(v, 'vv')),
    brancos: num(achar(v, 'vb')),
    pBrancos: num(achar(v, 'pvbn')) ?? num(achar(v, 'pvb')),
    nulos: num(achar(v, 'tvn')),
    pNulos: num(achar(v, 'ptvnn')) ?? num(achar(v, 'ptvn')),
    // Seções (s.ts = total, s.st = totalizadas): servem para somar a apuração por região.
    secoesTotal: num(achar(dados, 's', (x) => x && typeof x === 'object' && !Array.isArray(x))?.ts),
    secoesApuradas: num(achar(dados, 's', (x) => x && typeof x === 'object' && !Array.isArray(x))?.st),
    // Eleitores das seções ainda não totalizadas: teto de votos que ainda podem entrar.
    naoApurados: num(achar(eleitorado || dados, 'esnt')),
    abstencao: num(achar(eleitorado || dados, 'a')),
    pAbstencao: num(achar(eleitorado || dados, 'pan')) ?? num(achar(eleitorado || dados, 'pa')),
    definida: md === 's' || md === 'e' || cand.some((c) => c.eleito),
    totalizada: achar(dados, 'tf') === 's',
  };
}

// Um resultado só conta como publicado quando há seções totalizadas ou votos.
export const publicado = (r) => !!r && (r.pst > 0 || r.totalCand > 0);

// Modelos de caminho, do confirmado em 2026 para a hipótese herdada de 2022.
const MODELOS = [
  (ciclo, cd, uf, mun) => `${ciclo}/${cd}/dados/${uf}/${uf}${mun}-c0001-e${pad6(cd)}-u.json`,
  (ciclo, cd, uf, mun) => `${ciclo}/${cd}/dados-simplificados/${uf}/${uf}${mun}-c0001-e${pad6(cd)}-r.json`,
];
let modeloBom = 0, modeloConfirmado = false;

// Lê um resultado tentando os modelos; o primeiro que responder 200 vira o padrão.
export async function lerResultado(ciclo, cd, uf, mun = '') {
  uf = uf.toLowerCase();
  // Depois que um formato funcionou, não sonda o outro a cada 404 (no pico, cada leitura
  // extra aumenta a chance de o TSE responder 429).
  const ordem = modeloConfirmado ? [modeloBom] : [modeloBom, ...MODELOS.keys()].filter((v, i, a) => a.indexOf(v) === i);
  let ultimo = { status: 404, dados: null };
  for (const i of ordem) {
    const res = await lerJSON(MODELOS[i](ciclo, cd, uf, mun));
    if (res.status === 200 && res.dados) { modeloBom = i; modeloConfirmado = true; return { status: 200, resultado: interpretar(res.dados) }; }
    ultimo = res;
    if (res.status !== 404 && res.status !== 403) break; // erro de rede: não adianta trocar de modelo
  }
  return { status: ultimo.status, resultado: null };
}

// Configuração geral. Em 2026 o arquivo traz pl[] (pleitos) com c (ciclo) e e[] com cd e
// cdt2 (código do 2º turno); a hipótese de 2022 era c e e[] na raiz. Aceitamos as duas.
export function eleicoesDoCiclo(config, ciclo = 'ele2026') {
  const codigos = new Map();
  const visitar = (o, cicloAtual) => {
    if (Array.isArray(o)) return o.forEach((x) => visitar(x, cicloAtual));
    if (!o || typeof o !== 'object') return;
    const c = typeof o.c === 'string' && /^ele\d{4}$/.test(o.c) ? o.c : cicloAtual;
    if (Array.isArray(o.e) && c === ciclo) {
      for (const e of o.e) {
        if (!e || e.cd == null) continue;
        codigos.set(String(Number(e.cd)), e.nm || '');
        if (e.cdt2) codigos.set(String(Number(e.cdt2)), (e.nm || '').replace(/1º Turno/i, '2º Turno') + (/(1º Turno)/i.test(e.nm || '') ? '' : ' (2º turno)'));
      }
    }
    for (const [k, v] of Object.entries(o)) if (k !== 'e' && v && typeof v === 'object') visitar(v, c);
  };
  visitar(config, null);
  return [...codigos.entries()].map(([cd, nm]) => ({ cd, nm })).sort((a, b) => Number(b.cd) - Number(a.cd));
}

// Descobre o 2º turno presidencial: entre as eleições do ciclo, a de maior código cujo
// arquivo br-c0001 traz exatamente 2 candidatos. ?e=CODIGO pula a busca.
export async function descobrirEleicao(ciclo = 'ele2026', forcar = null) {
  const cfg = await lerJSON('comum/config/ele-c.json');
  if (cfg.status !== 200 || !cfg.dados) return { ok: false, motivo: 'config', status: cfg.status, testadas: [] };
  const lista = eleicoesDoCiclo(cfg.dados, ciclo);
  // Ordem de teste: 2º turno de eleição federal primeiro (onde está o presidente), depois
  // os demais 2º turnos e o resto, do maior código ao menor. Testa um por vez e para no
  // primeiro arquivo com 2 candidatos: no pico, 30 leituras simultâneas viravam 429.
  const peso = (el) => (/federal/i.test(el.nm) ? 0 : 2) + (/2º turno/i.test(el.nm) ? 0 : 1);
  const candidatas = forcar ? [{ cd: String(Number(forcar)), nm: 'forçada por ?e=' }]
    : lista.slice().sort((a, b) => peso(a) - peso(b) || Number(b.cd) - Number(a.cd));
  const testadas = [];
  let achada = null;
  for (const el of candidatas) {
    const r = await lerResultado(ciclo, el.cd, 'br');
    const t = { ...el, status: r.status, nCand: r.resultado ? r.resultado.cand.length : null, resultado: r.resultado };
    testadas.push(t);
    if (t.nCand === 2 || (forcar && t.resultado)) { achada = t; break; }
  }
  if (!achada) return { ok: false, motivo: lista.length ? 'sem2turno' : 'semciclo', testadas, lista };
  return { ok: true, ciclo, cd: achada.cd, nm: achada.nm, testadas, lista, br: achada.resultado };
}

// Municípios: abr[] com cd = UF e mu[] com cd (TSE), cdi (IBGE) e nm. Confirmado em 2026.
export async function lerMunicipios(ciclo, cd) {
  const res = await lerJSON(`${ciclo}/${cd}/config/mun-e${pad6(cd)}-cm.json`);
  if (res.status !== 200 || !res.dados) return { status: res.status, lista: [] };
  const lista = [];
  const abr = achar(res.dados, 'abr', Array.isArray) || [];
  for (const a of abr) {
    const uf = String(a.cd || '').toLowerCase();
    if (!/^[a-z]{2}$/.test(uf) || uf === 'br') continue; // zz (exterior) entra: tem tabela própria
    for (const m of a.mu || []) lista.push({ uf, cd: String(m.cd).padStart(5, '0'), cdi: m.cdi ? String(m.cdi) : null, nome: m.nm || '' });
  }
  return { status: 200, lista };
}

export const normalizarNome = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9]/g, '');
