// Modo demonstração (?demo=1): gera dados FICTÍCIOS no formato dos arquivos do TSE de 2026
// (dados/<uf>/<uf><mun>-c0001-e<cd>-u.json) e os entrega ao mesmo parser do modo real.
// A apuração vai de 0 a 100% em 10 minutos; ?p=50 começa no meio, para testes.
import { pad6 } from './parser.js?v=dev';

const DURACAO = 10 * 60 * 1000;
const CICLO = 'ele2026';
const REGIAO = { // inclinação regional fictícia: positivo favorece o 13
  ac: -0.08, am: 0.02, ap: 0.0, pa: 0.04, ro: -0.1, rr: -0.12, to: 0.0,
  al: 0.14, ba: 0.2, ce: 0.18, ma: 0.2, pb: 0.15, pe: 0.18, pi: 0.22, rn: 0.12, se: 0.15,
  df: -0.06, go: -0.1, ms: -0.1, mt: -0.14,
  es: -0.04, mg: 0.01, rj: -0.03, sp: -0.04, pr: -0.1, rs: -0.03, sc: -0.16,
};

// Hash determinístico: o mesmo município tem sempre o mesmo perfil.
function h(texto, sal) {
  let x = 2166136261 ^ sal;
  for (let i = 0; i < texto.length; i++) { x ^= texto.charCodeAt(i); x = Math.imul(x, 16777619); }
  x ^= x >>> 13; x = Math.imul(x, 0x5bd1e995); x ^= x >>> 15;
  return (x >>> 0) / 4294967296;
}
const br = (n, casas = 2) => n.toFixed(casas).replace('.', ',');

export function criarDemo(municipiosGeo) {
  const params = new URLSearchParams(location.search);
  const p0 = Math.min(100, Math.max(0, Number(params.get('p')) || 0)) / 100;
  const t0 = Date.now() - p0 * DURACAO;

  // Perfil fixo de cada município, criado a partir do mapa (o nome vai em caixa alta, como no TSE).
  const munis = municipiosGeo.map((f, i) => {
    const { ibge, nome, uf } = f.properties;
    const u = uf.toLowerCase();
    const eleitores = Math.round(1800 * Math.exp(4.6 * Math.pow(h(ibge, 1), 2.2)));
    const share13 = Math.min(0.9, Math.max(0.1, 0.5 + REGIAO[u] + (h(ibge, 2) - 0.5) * 0.45));
    return {
      uf: u, cd: String(10000 + i).padStart(5, '0'),
      // 1 em cada 25 sem cdi, para exercitar a ligação por nome + UF
      cdi: h(ibge, 7) < 0.04 ? null : ibge, nome: nome.toUpperCase(),
      eleitores, share13, comparec: 0.74 + h(ibge, 3) * 0.12,
      atraso: h(ibge, 4) * 0.7, vies: (h(ibge, 5) - 0.5) * 0.12,
      secoes: Math.max(1, Math.ceil(eleitores / 330)),
    };
  });
  // Exterior (zz): cidades fictícias com eleitorado pequeno, como no TSE.
  const CIDADES = ['LISBOA', 'PORTO', 'MIAMI', 'BOSTON', 'NOVA YORK', 'ORLANDO', 'TÓQUIO', 'NAGOIA', 'LONDRES', 'PARIS', 'MADRI', 'ROMA',
    'MILÃO', 'BERLIM', 'GENEBRA', 'ZURIQUE', 'TORONTO', 'MONTREAL', 'BUENOS AIRES', 'ASSUNÇÃO', 'SANTIAGO', 'SYDNEY', 'DUBLIN', 'BRUXELAS'];
  CIDADES.forEach((nome, i) => {
    const sal = 'zz' + nome;
    munis.push({
      uf: 'zz', cd: String(29000 + i * 8), cdi: null, nome, eleitores: Math.round(3000 + h(sal, 1) * 60000),
      share13: Math.min(0.85, Math.max(0.15, 0.45 + (h(sal, 2) - 0.5) * 0.5)), comparec: 0.45 + h(sal, 3) * 0.2,
      atraso: 0.2 + h(sal, 4) * 0.6, vies: (h(sal, 5) - 0.5) * 0.1, secoes: Math.max(1, Math.ceil((3000 + h(sal, 1) * 60000) / 400)),
    });
  });
  const porCodigo = new Map(munis.map((m) => [m.uf + m.cd, m]));
  const porUf = new Map();
  for (const m of munis) { if (!porUf.has(m.uf)) porUf.set(m.uf, []); porUf.get(m.uf).push(m); }

  const progresso = () => Math.min(1, (Date.now() - t0) / DURACAO);

  // Situação de um município no instante p: fração apurada e votos de cada candidato.
  function situacao(m, p) {
    const f = Math.min(1, Math.max(0, (p - m.atraso) / (1 - m.atraso)));
    const st = f >= 1 ? m.secoes : Math.floor(m.secoes * f);
    const fr = st / m.secoes;
    const comparecimento = Math.round(m.eleitores * m.comparec * fr);
    const brancos = Math.round(comparecimento * 0.016);
    const nulos = Math.round(comparecimento * 0.031);
    const validos = comparecimento - brancos - nulos;
    // Seções que chegam primeiro puxam para um lado; o viés some quando termina.
    const s13 = Math.min(0.97, Math.max(0.03, m.share13 + m.vies * (1 - fr)));
    const v13 = Math.round(validos * s13);
    return { ts: m.secoes, st, te: m.eleitores, esa: Math.round(m.eleitores * fr), c: comparecimento, brancos, nulos, validos, v13, v22: validos - v13 };
  }
  function somar(lista, p) {
    const t = { ts: 0, st: 0, te: 0, esa: 0, c: 0, brancos: 0, nulos: 0, validos: 0, v13: 0, v22: 0 };
    for (const m of lista) { const s = situacao(m, p); for (const k in t) t[k] += s[k]; }
    return t;
  }

  // Cache por segundo: BR e UFs somam milhares de municípios a cada leitura.
  // A chave inclui p: a eleição 900 (sempre 100%) e a 901 são lidas no mesmo segundo.
  let cacheChave = '', cacheBr = null;
  function totalBr(p) {
    const chave = Math.floor(Date.now() / 1000) + '|' + p.toFixed(4);
    if (chave !== cacheChave) { cacheChave = chave; cacheBr = somar(munis, p); }
    return cacheBr;
  }

  function arquivo(cd, tpabr, cdabr, s, pBr) {
    const agora = new Date();
    const hora = agora.toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour12: false });
    const data = agora.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
    const tb = totalBr(pBr);
    // O "TSE" fictício confirma o eleito um pouco depois de a vantagem superar o eleitorado
    // ainda não apurado; assim o modo demo mostra os dois estados (definido e eleito).
    const definido = pBr >= 1 || Math.abs(tb.v13 - tb.v22) > (tb.te - tb.esa) * 1.15;
    const lider = tb.v13 >= tb.v22 ? '13' : '22';
    const cand = (n, nm, nmu, sg, votos) => ({
      n, sqcand: '9' + n, nm, nmu, seq: n === '13' ? '1' : '2',
      e: definido && lider === n ? 's' : 'n',
      st: definido ? (lider === n ? 'Eleito' : 'Não eleito') : '',
      vap: String(votos), pvap: br(s.validos ? (100 * votos) / s.validos : 0), pvapn: String(s.validos ? (100 * votos) / s.validos : 0),
    });
    const pc = (a, b) => (b ? (100 * a) / b : 0);
    const json = {
      ele: String(cd), t: cd === 901 ? '2' : '1', f: 'o', sup: 'n', tpabr, cdabr, dg: data, hg: hora,
      dt: data, ht: hora, dv: 's', tf: s.st === s.ts ? 's' : 'n', and: s.st === s.ts ? 'f' : 's',
      carg: [{ cd: '1', nmn: 'Presidente', agr: [
        { n: '1', nm: 'COLIGAÇÃO FICTÍCIA A', tp: 'c', par: [{ n: '13', sg: 'PT', cand: [cand('13', 'LUIZ INÁCIO LULA DA SILVA', 'LULA', 'PT', s.v13)] }] },
        { n: '2', nm: 'PARTIDO FICTÍCIO B', tp: 'i', par: [{ n: '22', sg: 'PL', cand: [cand('22', 'FLAVIO NANTES BOLSONARO', 'FLAVIO BOLSONARO', 'PL', s.v22)] }] },
      ] }],
      s: { ts: String(s.ts), st: String(s.st), pst: br(pc(s.st, s.ts)), pstn: String(pc(s.st, s.ts)) },
      e: { te: String(s.te), est: String(s.esa), esnt: String(s.te - s.esa), c: String(s.c), pc: br(pc(s.c, s.esa)), a: String(s.esa - s.c), pa: br(pc(s.esa - s.c, s.esa)), pan: String(pc(s.esa - s.c, s.esa)) },
      v: { tv: String(s.c), vv: String(s.validos), pvv: br(pc(s.validos, s.c)), vb: String(s.brancos), pvb: br(pc(s.brancos, s.c)), pvbn: String(pc(s.brancos, s.c)), tvn: String(s.nulos), ptvn: br(pc(s.nulos, s.c)), ptvnn: String(pc(s.nulos, s.c)) },
    };
    if (cd === 900) { // 1º turno fictício com 4 candidatos: a descoberta precisa descartá-lo
      json.carg[0].agr.push({ n: '3', nm: 'X', par: [{ n: '30', sg: 'NOVO', cand: [{ n: '30', nmu: 'CANDIDATO C', vap: '0', pvap: '0,00' }] }] });
      json.carg[0].agr.push({ n: '4', nm: 'Y', par: [{ n: '55', sg: 'PSD', cand: [{ n: '55', nmu: 'CANDIDATO D', vap: '0', pvap: '0,00' }] }] });
    }
    return json;
  }

  const ok = (dados) => ({ status: 200, dados });
  const nao = { status: 404, dados: null };
  const espera = () => new Promise((r) => setTimeout(r, 20 + Math.random() * 80));

  return async function lerDemo(caminho) {
    await espera();
    if (caminho === 'comum/config/ele-c.json') {
      return ok({ dg: '25/10/2026', hg: '08:00:00', f: 'o', pl: [{ cd: '9999', c: CICLO, dt: '25/10/2026', e: [
        { cd: '900', cdt2: '901', nm: 'Eleição FICTÍCIA - 1º Turno', t: '1', tp: '8' },
      ] }] });
    }
    let m = caminho.match(/^ele2026\/(900|901)\/config\/mun-e(\d{6})-cm\.json$/);
    if (m) {
      return ok({ dg: '25/10/2026', hg: '08:00:00', abr: [...porUf.entries()].map(([uf, lista]) => ({
        cd: uf, ds: uf === 'zz' ? 'EXTERIOR' : uf.toUpperCase(), mu: lista.map((x) => (x.cdi ? { cd: x.cd, cdi: x.cdi, nm: x.nome } : { cd: x.cd, nm: x.nome })),
      })) });
    }
    m = caminho.match(/^ele2026\/(900|901)\/dados\/([a-z]{2})\/([a-z]{2})(\d{5})?-c0001-e(\d{6})-u\.json$/);
    if (!m || m[2] !== m[3] || pad6(m[1]) !== m[5]) return nao;
    const cd = Number(m[1]);
    const p = cd === 900 ? 1 : progresso();
    const uf = m[2], mun = m[4];
    if (uf === 'br' && !mun) return ok(arquivo(cd, 'br', 'br', totalBr(p), p));
    if (mun) {
      const x = porCodigo.get(uf + mun);
      return x ? ok(arquivo(cd, 'mu', mun, situacao(x, p), p)) : nao;
    }
    const lista = porUf.get(uf);
    return lista ? ok(arquivo(cd, 'uf', uf, somar(lista, p), p)) : nao;
  };
}
