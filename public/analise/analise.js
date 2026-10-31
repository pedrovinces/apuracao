// Página de análise: 1º x 2º turno seção por seção, urnas encerradas após as 17h e
// simulador de cenários. Tudo vem de arquivos estáticos gerados por tools/analise/montar.py
// a partir dos boletins e logs públicos do TSE; nada é calculado com dado de fora.
/* global d3, topojson */
import { criarMapa } from '../mapa.js?v=dev';
import { evento } from '../metricas.js?v=dev';

const $ = (s) => document.querySelector(s);
const REGIOES = {
  Norte: ['AC', 'AM', 'AP', 'PA', 'RO', 'RR', 'TO'],
  Nordeste: ['AL', 'BA', 'CE', 'MA', 'PB', 'PE', 'PI', 'RN', 'SE'],
  'Centro-Oeste': ['DF', 'GO', 'MS', 'MT'],
  Sudeste: ['ES', 'MG', 'RJ', 'SP'],
  Sul: ['PR', 'RS', 'SC'],
};
const NOME_UF = {
  AC: 'Acre', AL: 'Alagoas', AM: 'Amazonas', AP: 'Amapá', BA: 'Bahia', CE: 'Ceará', DF: 'Distrito Federal', ES: 'Espírito Santo',
  GO: 'Goiás', MA: 'Maranhão', MG: 'Minas Gerais', MS: 'Mato Grosso do Sul', MT: 'Mato Grosso', PA: 'Pará', PB: 'Paraíba',
  PE: 'Pernambuco', PI: 'Piauí', PR: 'Paraná', RJ: 'Rio de Janeiro', RN: 'Rio Grande do Norte', RO: 'Rondônia', RR: 'Roraima',
  RS: 'Rio Grande do Sul', SC: 'Santa Catarina', SE: 'Sergipe', SP: 'São Paulo', TO: 'Tocantins', ZZ: 'Exterior',
};
const COR = { 13: '#c81e1e', 22: '#1d4ed8', out: '#9a8f7d', bn: '#c9c3b6', abst: '#e8e3d9' };
const T17 = 17 * 60, T1715 = 17 * 60 + 15;

const fmt = new Intl.NumberFormat('pt-BR');
const fmtC = new Intl.NumberFormat('pt-BR', { notation: 'compact', maximumFractionDigits: 1 });
const pct = (v, c = 1) => (v == null || !Number.isFinite(v) ? '–' : v.toLocaleString('pt-BR', { minimumFractionDigits: c, maximumFractionDigits: c }) + '%');
const sinal = (v, f = fmt.format) => (v > 0 ? '+' : v < 0 ? '−' : '') + f(Math.abs(v));
const pp = (v) => (v == null ? '–' : (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + ' p.p.');
const hora = (m) => (m == null ? '–' : `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(Math.floor(m % 60)).padStart(2, '0')}`);
const titulo = (s) => String(s || '').toLowerCase().replace(/(^|\s)\S/g, (m) => m.toUpperCase()).replace(/ (D[aeo]s?|E) /g, (m) => m.toLowerCase());
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---------- dados ----------
let R; // resumo.json
const cacheUf = new Map(), cacheMun = new Map();
const json = async (u) => { const r = await fetch(u); if (!r.ok) throw new Error(u + ' ' + r.status); return r.json(); };
const lerUf = (uf) => { if (!cacheUf.has(uf)) cacheUf.set(uf, json(`dados/uf/${uf}.json?v=dev`)); return cacheUf.get(uf); };
const lerMun = (uf, cd) => { const k = uf + cd; if (!cacheMun.has(k)) cacheMun.set(k, json(`dados/mun/${uf}/${cd}.json?v=dev`)); return cacheMun.get(k); };

// Indicadores de um agregado {t1, t2, p}: percentuais sobre votos válidos de cada turno.
function ind(a) {
  const t1 = a.t1 || {}, t2 = a.t2 || {};
  const v1 = (t1['13'] || 0) + (t1['22'] || 0) + (t1.out || 0), v2 = (t2['13'] || 0) + (t2['22'] || 0);
  const r = {
    l1: v1 ? (100 * (t1['13'] || 0)) / v1 : null, f1: v1 ? (100 * (t1['22'] || 0)) / v1 : null, o1: v1 ? (100 * (t1.out || 0)) / v1 : null,
    l2: v2 ? (100 * (t2['13'] || 0)) / v2 : null, f2: v2 ? (100 * (t2['22'] || 0)) / v2 : null,
  };
  r.m1 = r.l1 != null ? r.l1 - r.f1 : null; r.m2 = r.l2 != null ? r.l2 - r.f2 : null;
  r.dm = r.m1 != null && r.m2 != null ? r.m2 - r.m1 : null;
  r.dl = r.l1 != null && r.l2 != null ? r.l2 - r.l1 : null; r.df = r.f1 != null && r.f2 != null ? r.f2 - r.f1 : null;
  return r;
}
// Seção: converte as listas compactas em objetos {t1, t2} com as mesmas chaves dos agregados.
function secaoAgg(l) {
  const t = (x) => (x ? { secoes: 1, apt: x[0], comp: x[1], abst: x[0] - x[1], 13: x[2], 22: x[3], out: x[4], br: x[5], nu: x[6], local: x[7], agr: x[8] } : null);
  return { zona: l[0], secao: l[1], t1: t(l[2]), t2: t(l[3]), ab: l[4], en: l[5], pos17: l[6], ultimo: l[7], parcial: !!l[8] };
}
function somaAgg(lista) {
  const s = { t1: {}, t2: {}, p: {} };
  for (const a of lista) for (const t of ['t1', 't2', 'p']) for (const [k, v] of Object.entries(a[t] || {})) if (typeof v === 'number') s[t][k] = (s[t][k] || 0) + v;
  return s;
}
const aggRegiao = (r) => R.regioes[r];
const aggUf = (uf) => R.ufs[uf];

// ---------- estado da navegação (refletido no endereço) ----------
const P = new URLSearchParams(location.search);
const est = {
  aba: ['turnos', 'horario', 'cidades', 'simulador'].includes(P.get('aba')) ? P.get('aba') : 'turnos',
  regiao: REGIOES[P.get('regiao')] ? P.get('regiao') : null,
  uf: NOME_UF[(P.get('uf') || '').toUpperCase()] ? P.get('uf').toUpperCase() : null,
  mun: P.get('mun') ? Number(P.get('mun')) : null,
  zona: P.get('zona') ? Number(P.get('zona')) : null,
  secao: P.get('secao') ? Number(P.get('secao')) : null,
  metrica: 'dm', ordem: { col: 'dm', asc: false },
};
const regiaoDaUf = (uf) => Object.keys(REGIOES).find((r) => REGIOES[r].includes(uf)) || (uf === 'ZZ' ? 'Exterior' : null);
function irPara(n) {
  if (n.mun !== est.mun) { est.filtroZona = null; est.limiteSecoes = 300; }
  Object.assign(est, { regiao: null, uf: null, mun: null, zona: null, secao: null }, n);
  if (est.uf && !est.regiao && est.uf !== 'ZZ') est.regiao = regiaoDaUf(est.uf);
  if (est.uf === 'ZZ') est.regiao = null; // exterior não tem região: evita "Exterior › Exterior" na trilha
  const p = new URLSearchParams();
  if (est.aba !== 'turnos') p.set('aba', est.aba);
  if (est.regiao && !est.uf) p.set('regiao', est.regiao);
  if (est.uf) p.set('uf', est.uf);
  if (est.mun) p.set('mun', est.mun);
  if (est.secao) { p.set('zona', est.zona); p.set('secao', est.secao); }
  history.pushState(null, '', location.pathname + (p.toString() ? '?' + p : ''));
  desenhar();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
addEventListener('popstate', () => { location.reload(); });

// ---------- geometria ----------
let geo, mapa;
async function carregarGeo() {
  const topo = await json('../geo/brasil.topo.json?v=dev');
  geo = { municipios: topojson.feature(topo, topo.objects.municipios), estados: topojson.feature(topo, topo.objects.estados) };
}

// ---------- componentes ----------
function trilha() {
  const partes = [['Brasil', {}]];
  if (est.regiao) partes.push([est.regiao, { regiao: est.regiao }]);
  if (est.uf) partes.push([NOME_UF[est.uf], { uf: est.uf }]);
  if (est.mun) partes.push([est.munNome || 'Município', { uf: est.uf, mun: est.mun }]);
  if (est.secao) partes.push([`Zona ${est.zona} · Seção ${est.secao}`, null]);
  $('#trilha').innerHTML = partes.map(([t, alvo], i) => (i < partes.length - 1 && alvo ? `<button type="button" data-ir='${JSON.stringify(alvo)}'>${esc(t)}</button><span aria-hidden="true">›</span>` : `<b>${esc(t)}</b>`)).join('');
}

// Cartão do comparativo, pensado para o celular: um bloco por candidato com percentuais
// grandes (1º → 2º turno), votos em formato curto e barras comparando os turnos; os números
// exatos ficam num "ver números exatos" para quem quiser conferir.
function cartaoTurnos(a, nome) {
  const i = ind(a), t1 = a.t1 || {}, t2 = a.t2 || {};
  const curto = (v) => (v == null ? '–' : Math.abs(v) >= 10000 ? fmtC.format(v) : fmt.format(v));
  const venc = (m) => (m == null ? '–' : `<b class="${m > 0 ? 't13' : 't22'}">${m > 0 ? 'Lula' : 'Flávio'}</b> <small>+${Math.abs(m).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} p.p.</small>`);
  const bloco = (n, nomeC, p1, p2, v1, v2) => `<div class="cand-turnos c${n}">
      <img src="../img/${n}.webp?v=dev" alt="" class="ct-foto" width="172" height="240">
      <div class="ct-corpo">
        <div class="ct-nome">${nomeC}</div>
        <div class="ct-pct"><span class="ct-p1">${pct(p1)}</span><span class="ct-seta" aria-hidden="true">→</span><b class="t${n}">${pct(p2)}</b></div>
        <div class="ct-votos">${curto(v1)} → <b>${curto(v2)}</b> votos <span class="ct-saldo ${v2 - v1 >= 0 ? 'pos' : 'neg'}">${sinal(v2 - v1, curto)}</span></div>
        <div class="ct-barras" aria-hidden="true"><span style="width:${p1 ?? 0}%" class="b1"></span><span style="width:${p2 ?? 0}%" class="b2 b${n}"></span></div>
      </div></div>`;
  const bn1 = (t1.br || 0) + (t1.nu || 0), bn2 = (t2.br || 0) + (t2.nu || 0);
  const pab1 = t1.apt ? (100 * t1.abst) / t1.apt : null, pab2 = t2.apt ? (100 * t2.abst) / t2.apt : null;
  const linha = (rot, v1, v2) => `<tr><th>${rot}</th><td>${v1 == null ? '–' : fmt.format(v1)}</td><td>${v2 == null ? '–' : fmt.format(v2)}</td><td>${v1 != null && v2 != null ? sinal(v2 - v1) : '–'}</td></tr>`;
  return `<section class="cartao cartao-comparativo">
    <h2>${esc(nome)}</h2>
    <div class="quem-venceu"><div><span>1º turno</span>${venc(i.m1)}</div><span class="qv-seta" aria-hidden="true">→</span><div><span>2º turno</span>${venc(i.m2)}</div></div>
    ${bloco(13, 'Lula', i.l1, i.l2, t1['13'], t2['13'])}
    ${bloco(22, 'Flávio Bolsonaro', i.f1, i.f2, t1['22'], t2['22'])}
    <p class="legenda-barras"><span class="lb1"></span>1º turno <span class="lb2"></span>2º turno · % dos votos válidos</p>
    <div class="mini-quadros">
      <div><span>Outros candidatos</span><b>${pct(i.o1)}</b><small>${curto(t1.out)} votos no 1º turno</small></div>
      <div><span>Brancos e nulos</span><b>${curto(bn1)} → ${curto(bn2)}</b><small>${sinal(bn2 - bn1, curto)}</small></div>
      <div><span>Abstenção</span><b>${pct(pab1)} → ${pct(pab2)}</b><small>${sinal((t2.abst || 0) - (t1.abst || 0), curto)} eleitores</small></div>
    </div>
    <details class="exatos"><summary>Ver números exatos</summary>
      <div class="tabela-rolagem"><table class="tabela-exata"><thead><tr><th></th><th>1º turno</th><th>2º turno</th><th>Saldo</th></tr></thead><tbody>
        ${linha('Lula', t1['13'], t2['13'])}${linha('Flávio', t1['22'], t2['22'])}${linha('Outros', t1.out, 0)}${linha('Brancos', t1.br, t2.br)}${linha('Nulos', t1.nu, t2.nu)}${linha('Abstenção', t1.abst, t2.abst)}${linha('Compareceram', t1.comp, t2.comp)}${linha('Aptos', t1.apt, t2.apt)}
      </tbody></table></div>
      <p class="nota-pequena">Percentuais dos candidatos sobre os votos válidos de cada turno; abstenção sobre os aptos.</p>
    </details>
  </section>`;
}

// "Para onde foram os votos": composição do eleitorado nos dois turnos e os saldos.
function cartaoTransicao(a) {
  const t1 = a.t1 || {}, t2 = a.t2 || {};
  if (!t1.apt || !t2.apt) return '';
  const seg = (t) => [['13', 'Lula', t['13'] || 0], ['22', 'Flávio', t['22'] || 0], ['out', 'Outros', t.out || 0], ['bn', 'Brancos e nulos', (t.br || 0) + (t.nu || 0)], ['abst', 'Abstenção', t.abst || 0]];
  const barra = (t, rot) => `<div class="pilha-rotulo">${rot}</div><div class="pilha" role="img" aria-label="Composição do eleitorado no ${rot}">${seg(t).filter(([, , v]) => v > 0).map(([k, n, v]) => `<span style="flex:${v};background:${COR[k]}" title="${n}: ${fmt.format(v)} (${pct((100 * v) / t.apt)})">${(100 * v) / t.apt >= 7 ? pct((100 * v) / t.apt, 0) : ''}</span>`).join('')}</div>`;
  const d = {
    l: (t2['13'] || 0) - (t1['13'] || 0), f: (t2['22'] || 0) - (t1['22'] || 0), o: -(t1.out || 0),
    bn: ((t2.br || 0) + (t2.nu || 0)) - ((t1.br || 0) + (t1.nu || 0)), ab: (t2.abst || 0) - (t1.abst || 0), apt: (t2.apt || 0) - (t1.apt || 0),
  };
  const item = (cor, rot, v, txt) => `<li><i class="ponto" style="background:${cor}"></i><span>${rot}</span><b class="${v > 0 ? 'pos' : v < 0 ? 'neg' : ''}">${sinal(v)}</b>${txt ? `<small>${txt}</small>` : ''}</li>`;
  return `<section class="cartao">
    <h2>Para onde foram os votos</h2>
    <p class="nota-pequena">Cada barra é o eleitorado inteiro (100% dos aptos) em um turno.</p>
    ${barra(t1, '1º turno')}${barra(t2, '2º turno')}
    <ul class="legenda-pilha">${seg(t1).map(([k, n]) => `<li><i class="ponto" style="background:${COR[k]}"></i>${n}</li>`).join('')}</ul>
    <h3>Saldos do 1º para o 2º turno</h3>
    <ul class="saldos">
      ${item(COR[13], 'Lula', d.l)}${item(COR[22], 'Flávio', d.f)}
      ${item(COR.out, 'Outros candidatos', d.o, 'não estavam no 2º turno')}
      ${item(COR.bn, 'Brancos e nulos', d.bn)}${item(COR.abst, 'Abstenção', d.ab)}
      ${d.apt ? item('transparent', 'Eleitores aptos', d.apt, 'transferências e ajustes do cadastro') : ''}
    </ul>
    <p class="nota-pequena">São <b>saldos</b>, não migração de eleitores: o voto é secreto, então não há como saber se quem votou em outro candidato no 1º turno foi para Lula, para Flávio ou deixou de votar. Os saldos fecham a conta: ganho de Lula + ganho de Flávio + variação de brancos, nulos e abstenção = votos dos outros candidatos + variação de aptos.</p>
  </section>`;
}

// Cor do mapa da virada: variação (pontos percentuais) entre turnos.
const METRICAS = {
  dm: { nome: 'Variação da margem (Lula − Flávio)', pos: COR[13], neg: COR[22], legPos: 'margem andou para Lula', legNeg: 'margem andou para Flávio' },
  dl: { nome: 'Variação de Lula', pos: COR[13], neg: '#6b7280', legPos: 'Lula subiu', legNeg: 'Lula caiu' },
  df: { nome: 'Variação de Flávio', pos: COR[22], neg: '#6b7280', legPos: 'Flávio subiu', legNeg: 'Flávio caiu' },
};
let neutro = '#efe8dc', semDados = '#cbcbcb';
function lerTema() { const c = getComputedStyle(document.documentElement); neutro = c.getPropertyValue('--neutro').trim() || neutro; semDados = c.getPropertyValue('--semdados').trim() || semDados; }
function corVar(v) {
  if (v == null) return semDados;
  const m = METRICAS[est.metrica];
  const t = 0.15 + 0.85 * Math.min(1, Math.abs(v) / 25);
  return d3.interpolateRgb(neutro, v >= 0 ? m.pos : m.neg)(t);
}

function cartaoMapa() {
  const m = METRICAS[est.metrica];
  return `<section class="cartao">
    <div class="mapa-topo"><h2>Mapa da virada</h2>
      <label class="seletor-metrica"><span class="visualmente-oculto">Medida</span><select id="metrica">${Object.entries(METRICAS).map(([k, v]) => `<option value="${k}"${k === est.metrica ? ' selected' : ''}>${v.nome}</option>`).join('')}</select></label>
    </div>
    <div id="mapa" class="mapa"></div>
    <div class="legenda"><span class="rampa"><i style="background:linear-gradient(90deg, ${m.neg}, ${neutro}, ${m.pos})"></i></span><span>${m.legNeg} · ${m.legPos} (satura em 25 p.p.)</span></div>
    <p class="dica-uso">Toque num ${est.uf ? 'município' : 'estado'} para abrir.</p>
  </section>`;
}

// Tabela de locais filhos (regiões, UFs ou municípios), ordenável.
function tabelaLocais(titulo, linhas) {
  const cols = [['nome', 'Local'], ['l', 'Lula'], ['f', 'Flávio'], ['dm', 'Δ margem']];
  const { col, asc } = est.ordem;
  const chave = { nome: (x) => x.nome, l: (x) => x.i.l2 ?? -1, f: (x) => x.i.f2 ?? -1, dm: (x) => x.i.dm ?? -999 }[col] || ((x) => x.i.dm);
  linhas.sort((a, b) => { const va = chave(a), vb = chave(b); const c = typeof va === 'string' ? va.localeCompare(vb, 'pt-BR') : va - vb; return asc ? c : -c; });
  return `<section class="cartao"><h2>${esc(titulo)}</h2>
    <div class="tabela-rolagem"><table class="tabela-locais"><thead><tr>${cols.map(([k, t]) => `<th><button type="button" data-ordem="${k}" aria-sort="${col === k ? (asc ? 'ascending' : 'descending') : 'none'}">${t}${col === k ? (asc ? ' ↑' : ' ↓') : ''}</button></th>`).join('')}</tr></thead>
    <tbody>${linhas.map((x) => `<tr data-ir='${JSON.stringify(x.alvo)}'><td>${esc(x.nome)}</td><td><span class="de">${pct(x.i.l1)} →</span><b class="t13">${pct(x.i.l2)}</b></td><td><span class="de">${pct(x.i.f1)} →</span><b class="t22">${pct(x.i.f2)}</b></td><td class="${x.i.dm > 0 ? 't13' : 't22'}">${pp(x.i.dm)}</td></tr>`).join('')}</tbody></table></div></section>`;
}

// ---------- aba 1: 1º → 2º turno ----------
async function abaTurnos() {
  const c = $('#conteudo');
  if (est.secao) return detalheSecao();
  if (est.mun) return tabelaSecoes();
  let a, nome, filhos = [];
  if (est.uf) {
    a = aggUf(est.uf); nome = NOME_UF[est.uf];
    const d = await lerUf(est.uf);
    filhos = Object.entries(d.municipios).map(([cd, m]) => ({ nome: titulo(m.nome), i: ind(m), alvo: { uf: est.uf, mun: Number(cd) }, ibge: m.ibge }));
  } else if (est.regiao) {
    a = aggRegiao(est.regiao); nome = `Região ${est.regiao}`;
    filhos = (REGIOES[est.regiao] || ['ZZ']).map((uf) => ({ nome: NOME_UF[uf], i: ind(aggUf(uf)), alvo: { uf } }));
  } else {
    a = R.br; nome = 'Brasil';
    filhos = [...Object.keys(REGIOES), 'Exterior'].map((r) => ({ nome: r, i: ind(aggRegiao(r)), alvo: r === 'Exterior' ? { uf: 'ZZ' } : { regiao: r } }));
  }
  const comMapa = est.uf !== 'ZZ' && est.regiao !== 'Exterior';
  c.innerHTML = cartaoTurnos(a, nome) + cartaoTransicao(a) + (comMapa ? cartaoMapa() : '')
    + tabelaLocais(est.uf ? 'Municípios' : est.regiao ? 'Estados' : 'Regiões', filhos)
    + (!est.uf && !est.regiao ? tabelaLocais('Estados', Object.keys(R.ufs).map((uf) => ({ nome: NOME_UF[uf], i: ind(aggUf(uf)), alvo: { uf } }))) : '')
    + (est.uf && est.uf !== 'ZZ' ? await cartaoViradas() : '');
  if (comMapa) desenharMapa(filhos);
}

async function cartaoViradas() {
  const d = await lerUf(est.uf);
  const nomeMun = (cd) => titulo(d.municipios[cd]?.nome);
  const lista = (l) => l.slice(0, 12).map(([mun, z, s, dm]) => `<li><button type="button" data-ir='${JSON.stringify({ uf: est.uf, mun, zona: z, secao: s })}'>${esc(nomeMun(mun))} · zona ${z} · seção ${s}</button><b class="${dm > 0 ? 't13' : 't22'}">${pp(dm)}</b></li>`).join('');
  return `<section class="cartao"><h2>Seções com maior variação de margem</h2>
    <p class="nota-pequena">Entre seções com pelo menos 50 eleitores votando nos dois turnos. Variações grandes costumam vir de seções pequenas, agregadas de forma diferente entre turnos ou com mudança de local.</p>
    <div class="duas-listas"><div><h3 class="t13">Mais na direção de Lula</h3><ol class="lista-secoes">${lista(d.maior_virada_13)}</ol></div>
    <div><h3 class="t22">Mais na direção de Flávio</h3><ol class="lista-secoes">${lista(d.maior_virada_22)}</ol></div></div></section>`;
}

function desenharMapa(filhos) {
  const alvo = $('#mapa');
  if (!alvo) return;
  alvo.innerHTML = '';
  const porUf = new Map(Object.keys(R.ufs).map((uf) => [uf, ind(aggUf(uf))]));
  const porIbge = new Map(filhos.filter((x) => x.ibge).map((x) => [x.ibge, x]));
  mapa = criarMapa(alvo, geo, {
    passar(tipo, f, ev) { dica(tipo, f, ev, porUf, porIbge); },
    sair() { $('#dica').hidden = true; },
    clicar(tipo, f) { $('#dica').hidden = true; if (tipo === 'uf') irPara({ uf: f.properties.uf }); else { const x = porIbge.get(f.properties.ibge); if (x) irPara(x.alvo); } },
  });
  mapa.mostrar({ modo: est.uf ? 'municipios' : 'estados', uf: est.uf, regiao: !est.uf && est.regiao ? REGIOES[est.regiao] : null });
  const val = (i) => (i ? i[est.metrica] : null);
  mapa.colorir({ uf: (f) => corVar(val(porUf.get(f.properties.uf))), mun: (f) => corVar(val(porIbge.get(f.properties.ibge)?.i)) });
}
function dica(tipo, f, ev, porUf, porIbge) {
  const i = tipo === 'uf' ? porUf.get(f.properties.uf) : porIbge.get(f.properties.ibge)?.i;
  const nome = tipo === 'uf' ? NOME_UF[f.properties.uf] : f.properties.nome;
  const d = $('#dica');
  d.innerHTML = `<b>${esc(nome)}</b><br>${i ? `Lula ${pct(i.l1)} → ${pct(i.l2)}<br>Flávio ${pct(i.f1)} → ${pct(i.f2)}<br>Margem ${pp(i.dm)}` : 'sem dados'}`;
  d.hidden = false;
  d.style.left = Math.min(innerWidth - 230, ev.clientX + 14) + 'px'; d.style.top = ev.clientY + 14 + 'px';
}

// Município: seções agrupadas por zona, com 1º e 2º turno em votos.
async function tabelaSecoes() {
  const d = await lerMun(est.uf, est.mun);
  est.munNome = titulo(d.nome); trilha();
  const secs = d.secoes.map(secaoAgg);
  const total = somaAgg(secs);
  const v = (t, k) => (t ? fmt.format(t[k]) : '–');
  const flag = (s) => (!s.t1 || !s.t2 ? '<i class="flag" title="Seção existe em apenas um turno">◐</i>' : (s.t1.agr || s.t2.agr) && String(s.t1.agr) !== String(s.t2.agr) ? '<i class="flag" title="Agregação de seções diferente entre os turnos">⚠</i>' : '');
  // Municípios grandes (São Paulo tem ~27 mil seções): filtro por zona e 300 linhas por vez.
  const zonas = [...new Set(secs.map((s) => s.zona))].sort((a, b) => a - b);
  const filtradas = est.filtroZona ? secs.filter((s) => s.zona === est.filtroZona) : secs;
  const limite = est.limiteSecoes || 300;
  const linhas = filtradas.slice(0, limite).map((s) => `<tr data-ir='${JSON.stringify({ uf: est.uf, mun: est.mun, zona: s.zona, secao: s.secao })}'>
    <td>${s.zona}/${s.secao}${flag(s)}</td><td><span class="de">${v(s.t1, 13)} →</span><b class="t13">${v(s.t2, 13)}</b></td><td><span class="de">${v(s.t1, 22)} →</span><b class="t22">${v(s.t2, 22)}</b></td>
    <td class="${s.en > T1715 ? 'tarde' : ''}">${hora(s.en)}</td><td>${s.pos17 == null ? '<span class="sem">·</span>' : (s.parcial ? '≥' : '') + fmt.format(s.pos17)}</td></tr>`).join('');
  const filtro = zonas.length > 1 ? `<label class="filtro-zona">Zona <select id="filtro-zona"><option value="">todas (${zonas.length})</option>${zonas.map((z) => `<option value="${z}"${z === est.filtroZona ? ' selected' : ''}>${z}</option>`).join('')}</select></label>` : '';
  const mais = filtradas.length > limite ? `<button type="button" class="botao-leve largo" id="mais-secoes">Mostrar mais (${fmt.format(filtradas.length - limite)} restantes)</button>` : '';
  $('#conteudo').innerHTML = cartaoTurnos(total, est.munNome) + cartaoTransicao(total) + `<section class="cartao"><h2>Seções (${fmt.format(filtradas.length)}${est.filtroZona ? ` na zona ${est.filtroZona}` : ''})</h2>${filtro}
    <p class="nota-pequena">Votos de Lula e Flávio no 1º → 2º turno. "Fechou" é o encerramento da urna no 2º turno (Brasília); em destaque, depois das 17:15. "Pós-17h" é a contagem de votos do log (só nas seções analisadas; · = não analisada). ⚠ agregação diferente entre turnos; ◐ seção em um turno só. Toque numa linha para abrir.</p>
    <div class="tabela-rolagem"><table class="tabela-secoes"><thead><tr><th>Zona/Seção</th><th>Lula</th><th>Flávio</th><th>Fechou</th><th>Pós-17h</th></tr></thead><tbody>${linhas}</tbody></table></div>${mais}</section>`;
  $('#filtro-zona')?.addEventListener('change', (ev) => { est.filtroZona = ev.target.value ? Number(ev.target.value) : null; est.limiteSecoes = 300; tabelaSecoes(); });
  $('#mais-secoes')?.addEventListener('click', () => { est.limiteSecoes = limite + 300; tabelaSecoes(); });
}

async function detalheSecao() {
  const d = await lerMun(est.uf, est.mun);
  est.munNome = titulo(d.nome); trilha();
  const l = d.secoes.find((x) => x[0] === est.zona && x[1] === est.secao);
  if (!l) { $('#conteudo').innerHTML = '<section class="cartao"><p>Seção não encontrada.</p></section>'; return; }
  const s = secaoAgg(l);
  const uf = est.uf.toLowerCase(), m5 = String(est.mun).padStart(5, '0'), z4 = String(est.zona).padStart(4, '0'), s4 = String(est.secao).padStart(4, '0');
  const aux = (pl) => `https://resultados.tse.jus.br/oficial/ele2026/arquivo-urna/${pl}/dados/${uf}/${m5}/${z4}/${s4}/p00${pl}-${uf}-m${m5}-z${z4}-s${s4}-aux.json`;
  const avisos = [];
  if (!s.t1 || !s.t2) avisos.push('Esta seção aparece em apenas um dos turnos (pode ter sido agregada a outra).');
  if (s.t1?.agr || s.t2?.agr) avisos.push(`Seções agregadas a esta urna: 1º turno ${s.t1?.agr || 'nenhuma'}; 2º turno ${s.t2?.agr || 'nenhuma'}. Quando a agregação muda, os eleitores não são os mesmos nos dois turnos.`);
  if (s.t1 && s.t2 && s.t1.local !== s.t2.local) avisos.push(`O local de votação mudou entre os turnos (${s.t1.local} → ${s.t2.local}).`);
  const horario = s.en == null ? '' : `<section class="cartao"><h2>Horários do 2º turno (Brasília)</h2>
    <dl class="pares"><div><dt>Abertura</dt><dd>${hora(s.ab)}</dd></div><div><dt>Encerramento</dt><dd class="${s.en > T1715 ? 'tarde' : ''}">${hora(s.en)}</dd></div>
    <div><dt>Último voto</dt><dd>${s.ultimo == null ? 'não analisado' : hora(s.ultimo)}</dd></div><div><dt>Votos depois das 17h</dt><dd>${s.pos17 == null ? 'não analisado' : fmt.format(s.pos17)}</dd></div></dl>
    ${s.parcial ? '<p class="aviso">O log desta urna registra menos votos do que o boletim (provável troca de urna ou votação em cédula). A contagem depois das 17h é um piso: pode haver mais.</p>' : ''}
    <p class="nota-pequena">${s.pos17 == null ? 'O log desta seção não foi analisado: analisamos todas as seções que fecharam depois das 17:15 e uma amostra das que fecharam entre 17:00 e 17:15.' : `Contagem feita no log da urna: ${fmt.format(s.pos17)} de ${fmt.format(s.t2?.comp || 0)} eleitores votaram depois das 17:00. O log não diz em quem votaram (voto secreto).`}</p></section>`;
  $('#conteudo').innerHTML = (avisos.length ? `<div class="aviso">${avisos.map(esc).join('<br>')}</div>` : '')
    + cartaoTurnos(s, `${est.munNome} · zona ${est.zona} · seção ${est.secao}`) + cartaoTransicao(s) + horario
    + `<section class="cartao"><h2>Conferir no TSE</h2><p class="nota-pequena">Arquivos oficiais desta seção (boletim de urna, log e registro digital do voto), para qualquer pessoa verificar:</p>
      <ul class="links"><li><a href="${aux(3220)}" target="_blank" rel="noopener">1º turno: arquivos da urna</a></li><li><a href="${aux(3221)}" target="_blank" rel="noopener">2º turno: arquivos da urna</a></li></ul></section>`;
}

// ---------- aba 2: urnas após 17h ----------
function escopoUfs() { return est.uf ? [est.uf] : est.regiao ? (REGIOES[est.regiao] || ['ZZ']) : Object.keys(R.ufs); }
function faixasEscopo() {
  const soma = new Map();
  for (const uf of escopoUfs()) for (const [f, c] of Object.entries(R.simulador[uf] || {})) {
    if (f === 'sem') continue;
    const s = soma.get(+f) || { secoes: 0, comp: 0, 13: 0, 22: 0, pos17: 0 };
    for (const k of Object.keys(s)) s[k] += c[k] || 0;
    soma.set(+f, s);
  }
  return [...soma.entries()].sort((a, b) => a[0] - b[0]);
}
async function abaHorario() {
  const a = est.uf ? aggUf(est.uf) : est.regiao ? aggRegiao(est.regiao) : R.br;
  const nome = est.uf ? NOME_UF[est.uf] : est.regiao ? `Região ${est.regiao}` : 'Brasil';
  if (est.uf === 'ZZ' || est.regiao === 'Exterior') { $('#conteudo').innerHTML = '<section class="cartao"><h2>Exterior</h2><p>As seções do exterior seguem o horário local de cada país e não entram nesta análise.</p></section>'; return; }
  const p = a.p || {}, t2 = a.t2 || {};
  const media = R.pos17.fila.media || 0;
  const filaEst = (p.fila || 0) * media;
  const filaMargem = R.pos17.fila.populacao ? (R.pos17.fila.margem95 * (p.fila || 0)) / R.pos17.fila.populacao : 0;
  // Teto: contados + votos que faltam nos logs incompletos + estimativa da fila com a margem de erro.
  const tardios = (p.pos17 || 0) + (p.pos17_teto_extra || 0) + filaEst + filaMargem;
  const margem = (t2['13'] || 0) - (t2['22'] || 0);
  const lider = margem >= 0 ? 'Lula' : 'Flávio';
  const semProrrog = margem - ((p['13_prorrogadas'] || 0) - (p['22_prorrogadas'] || 0));
  $('#conteudo').innerHTML = `
    <section class="cartao"><h2>${esc(nome)}: urnas após as 17h</h2>
      <div class="numeros-grandes">
        <div><b>${fmt.format(p.prorrogadas || 0)}</b><span>seções fecharam depois das 17:15 (${pct((100 * (p.prorrogadas || 0)) / (t2.secoes || 1), 2)} do total)</span></div>
        <div><b>${fmt.format(p.pos17 || 0)}</b><span>votos depois das 17h contados nos logs dessas seções (${fmt.format(p.contadas || 0)} logs lidos${p.logs_parciais ? `; em ${fmt.format(p.logs_parciais)} o log está incompleto e pode haver até mais ${fmt.format(p.pos17_teto_extra || 0)}` : ''})</span></div>
        <div><b>${fmtC.format(filaEst)}</b><span>votos de fila estimados depois das 17h nas ${fmt.format(p.fila || 0)} seções que fecharam entre 17:00 e 17:15 (± ${fmtC.format(filaMargem)}, 95% de confiança)</span></div>
        <div><b>${fmt.format(p.comp_prorrogadas || 0)}</b><span>eleitores votaram, no dia inteiro, nas seções que fecharam depois das 17:15</span></div>
      </div>
    </section>
    <section class="cartao destaque-impacto"><h2>A prorrogação decidiria o resultado?</h2>
      <ul class="impacto">
        <li><span>Vantagem de ${lider} no 2º turno</span><b>${fmt.format(Math.abs(margem))} votos</b></li>
        <li><span>Vantagem de ${lider} retirando por inteiro as seções que fecharam depois das 17:15</span><b>${fmt.format(Math.abs(semProrrog))} votos${Math.sign(semProrrog) !== Math.sign(margem) ? ' (inverte)' : ''}</b></li>
        <li><span>Hipótese extrema: todos os votos depois das 17h (no máximo ~${fmtC.format(tardios)}) teriam ido para ${lider} e são retirados</span><b>${fmt.format(Math.round(Math.abs(margem) - tardios))} votos${Math.abs(margem) - tardios < 0 ? ' (inverte)' : ''}</b></li>
      </ul>
      <p class="nota-pequena">A hipótese extrema é um teto: na prática os votos depois das 17h se dividem entre os candidatos. Mesmo assim ela mostra o tamanho máximo possível do efeito.</p>
    </section>
    <section class="cartao"><h2>Quando as urnas fecharam</h2><p class="nota-pequena">Número de seções por horário de encerramento (Brasília, faixas de 5 min, escala logarítmica). Antes de 16:30 tudo entra na primeira barra.</p><div id="g-encerramento" class="grafico"></div></section>
    <section class="cartao"><h2>Resultado por horário de encerramento</h2><p class="nota-pequena">Percentual de Lula no 2º turno entre as seções de cada faixa. Seções que fecham mais tarde costumam ter fila maior (mais eleitores, áreas urbanas e periferias), e isso também muda o perfil do voto: a relação é correlação, não causa.</p><div id="g-resultado" class="grafico"></div></section>
    ${est.uf ? await tabelaProrrogadas() : tabelaHorarioUfs()}`;
  graficoEncerramento(); graficoResultado();
}
function tabelaHorarioUfs() {
  const linhas = escopoUfs().filter((u) => u !== 'ZZ').map((uf) => ({ uf, p: aggUf(uf).p || {}, t2: aggUf(uf).t2 || {} }))
    .sort((a, b) => (b.p.prorrogadas || 0) - (a.p.prorrogadas || 0));
  return `<section class="cartao"><h2>Por estado</h2><div class="tabela-rolagem"><table class="tabela-locais"><thead><tr><th>Estado</th><th>Fecharam após 17:15</th><th>Votos após 17h</th><th>Lula % nelas</th></tr></thead><tbody>
    ${linhas.map(({ uf, p }) => { const v = (p['13_prorrogadas'] || 0) + (p['22_prorrogadas'] || 0); return `<tr data-ir='${JSON.stringify({ uf })}'><td>${NOME_UF[uf]}</td><td>${fmt.format(p.prorrogadas || 0)}</td><td>${fmt.format(p.pos17 || 0)}</td><td>${v ? pct((100 * p['13_prorrogadas']) / v) : '–'}</td></tr>`; }).join('')}
  </tbody></table></div></section>`;
}
async function tabelaProrrogadas() {
  const d = await lerUf(est.uf);
  const l = d.prorrogadas;
  return `<section class="cartao"><h2>Seções que fecharam depois das 17:15 (${fmt.format(l.length)})</h2>
    <div class="tabela-rolagem"><table class="tabela-secoes"><thead><tr><th>Município · zona/seção</th><th>Fechou</th><th>Votaram</th><th>Lula × Flávio</th><th>Pós-17h</th></tr></thead><tbody>
    ${l.slice(0, 400).map(([mun, z, s, en, comp, v13, v22, pos, parcial]) => `<tr data-ir='${JSON.stringify({ uf: est.uf, mun, zona: z, secao: s })}'><td>${esc(titulo(d.municipios[mun]?.nome))} · ${z}/${s}</td><td class="tarde">${hora(en)}</td><td>${fmt.format(comp)}</td><td><span class="t13">${fmt.format(v13)}</span> × <span class="t22">${fmt.format(v22)}</span></td><td>${pos == null ? '·' : (parcial ? '≥' : '') + fmt.format(pos)}</td></tr>`).join('')}
    </tbody></table></div>${l.length > 400 ? `<p class="nota-pequena">Mostrando as 400 que fecharam mais tarde.</p>` : ''}</section>`;
}
function eixoHora(g, x, alt) {
  g.append('g').attr('transform', `translate(0,${alt})`).call(d3.axisBottom(x).tickValues(x.domain().filter((m) => m % 30 === 0)).tickFormat(hora)).call((s) => s.selectAll('text').attr('font-size', 10));
}
function graficoEncerramento() {
  const dados = faixasEscopo(); const el = $('#g-encerramento'); if (!el || !dados.length) return;
  const W = el.clientWidth || 340, H = 220, m = { t: 10, r: 8, b: 26, l: 44 };
  const x = d3.scaleBand().domain(dados.map((d) => d[0])).range([m.l, W - m.r]).padding(0.12);
  const y = d3.scaleLog().domain([1, d3.max(dados, (d) => d[1].secoes) * 1.2]).range([H - m.b, m.t]).clamp(true);
  const svg = d3.select(el).append('svg').attr('viewBox', `0 0 ${W} ${H}`).attr('class', 'svg-grafico');
  svg.append('g').attr('transform', `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(4, '~s')).call((s) => s.selectAll('text').attr('font-size', 10));
  svg.append('g').selectAll('rect').data(dados).join('rect').attr('x', (d) => x(d[0])).attr('width', x.bandwidth())
    .attr('y', (d) => y(Math.max(1, d[1].secoes))).attr('height', (d) => y(1) - y(Math.max(1, d[1].secoes)))
    .attr('fill', (d) => (d[0] >= T1715 ? '#d97706' : 'var(--texto)')).append('title').text((d) => `${hora(d[0])}–${hora(d[0] + 5)}: ${fmt.format(d[1].secoes)} seções`);
  eixoHora(svg, x, H - m.b);
}
function graficoResultado() {
  const dados = faixasEscopo().filter((d) => d[1]['13'] + d[1]['22'] > 0); const el = $('#g-resultado'); if (!el || !dados.length) return;
  const W = el.clientWidth || 340, H = 220, m = { t: 10, r: 8, b: 26, l: 44 };
  const x = d3.scaleBand().domain(dados.map((d) => d[0])).range([m.l, W - m.r]).padding(0.12);
  const y = d3.scaleLinear().domain([30, 70]).range([H - m.b, m.t]).clamp(true);
  const svg = d3.select(el).append('svg').attr('viewBox', `0 0 ${W} ${H}`).attr('class', 'svg-grafico');
  svg.append('g').attr('transform', `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(4).tickFormat((v) => v + '%')).call((s) => s.selectAll('text').attr('font-size', 10));
  svg.append('line').attr('x1', m.l).attr('x2', W - m.r).attr('y1', y(50)).attr('y2', y(50)).attr('stroke', 'currentColor').attr('stroke-dasharray', '3 3').attr('opacity', 0.4);
  const l = (d) => (100 * d[1]['13']) / (d[1]['13'] + d[1]['22']);
  svg.append('g').selectAll('circle').data(dados).join('circle').attr('cx', (d) => x(d[0]) + x.bandwidth() / 2).attr('cy', (d) => y(l(d)))
    .attr('r', (d) => Math.max(2, Math.min(9, Math.log10(d[1].secoes + 1) * 2.2))).attr('fill', (d) => (l(d) >= 50 ? COR[13] : COR[22])).attr('opacity', 0.85)
    .append('title').text((d) => `${hora(d[0])}–${hora(d[0] + 5)}: Lula ${pct(l(d))} em ${fmt.format(d[1].secoes)} seções`);
  eixoHora(svg, x, H - m.b);
}

// ---------- aba: cidades (filtros e extremos) ----------
let cidades = null, extremas = null;
const fc = { venc: 'todos', virada: 'todas', fCaiu: false, lCaiu: false, dfMax: 40, dlMin: -40, minEl: 0, ordem: 'queda_fv', limite: 150, eixo: 'outros' };
function prepCidades(d) {
  return d.cidades.map(([uf, cd, nome, ibge, apt1, comp1, l1, f1, o1, bn1, apt2, comp2, l2, f2, bn2]) => {
    const v1 = l1 + f1 + o1, v2 = l2 + f2;
    const pl1 = v1 ? (100 * l1) / v1 : 0, pf1 = v1 ? (100 * f1) / v1 : 0, po1 = v1 ? (100 * o1) / v1 : 0;
    const pl2 = v2 ? (100 * l2) / v2 : 0, pf2 = v2 ? (100 * f2) / v2 : 0;
    return { uf, cd, nome: titulo(nome), apt2, l1, f1, o1, l2, f2, comp1, comp2, pl1, pf1, po1, pl2, pf2,
      dl: pl2 - pl1, df: pf2 - pf1, dm: (pl2 - pf2) - (pl1 - pf1), dLv: l2 - l1, dFv: f2 - f1, dC: comp2 - comp1,
      v1w: l1 >= f1 ? '13' : '22', v2w: l2 >= f2 ? '13' : '22', dabst: (comp1 ? (100 * (comp2 - comp1)) / comp1 : 0) };
  });
}
function filtrar() {
  const escopo = est.uf ? (c) => c.uf === est.uf : est.regiao ? (c) => (REGIOES[est.regiao] || ['ZZ']).includes(c.uf) : () => true;
  const l = cidades.filter((c) => escopo(c)
    && (fc.venc === 'todos' || c.v2w === fc.venc)
    && (fc.virada === 'todas' || (fc.virada === '13' ? c.v1w === '22' && c.v2w === '13' : c.v1w === '13' && c.v2w === '22'))
    && (!fc.fCaiu || c.dFv < 0) && (!fc.lCaiu || c.dLv < 0)
    && c.df <= fc.dfMax && c.dl >= fc.dlMin && c.apt2 >= fc.minEl);
  const ord = { queda_fv: (c) => c.dFv, queda_fp: (c) => c.df, ganho_lp: (c) => -c.dl, margem_l: (c) => -c.dm, margem_f: (c) => c.dm, maiores: (c) => -c.apt2, queda_lv: (c) => c.dLv }[fc.ordem];
  return l.sort((a, b) => ord(a) - ord(b));
}
async function abaCidades() {
  if (!cidades) cidades = prepCidades(await json('dados/cidades.json?v=dev'));
  const seg = (nome, atual, op) => `<div class="segmentado mini" role="group">${op.map(([v, t]) => `<button type="button" data-fc="${nome}" data-v="${v}" aria-pressed="${String(atual) === v}">${t}</button>`).join('')}</div>`;
  $('#conteudo').innerHTML = `<section class="cartao filtros-cidades"><h2>Comparar cidades</h2>
      <p class="nota-pequena">Escolha o recorte no seletor acima (Brasil, região ou estado) e combine os filtros. Toque numa cidade para abrir as seções dela.</p>
      <div class="filtro"><span>Venceu no 2º turno</span>${seg('venc', fc.venc, [['todos', 'Todos'], ['13', 'Lula'], ['22', 'Flávio']])}</div>
      <div class="filtro"><span>Virada entre turnos</span>${seg('virada', fc.virada, [['todas', 'Todas'], ['13', 'Virou para Lula'], ['22', 'Virou para Flávio']])}</div>
      <div class="filtro"><span>Perdeu votos do 1º para o 2º</span><div class="chips">
        <button type="button" class="chip" data-fc="fCaiu" aria-pressed="${fc.fCaiu}">Flávio teve menos votos</button>
        <button type="button" class="chip" data-fc="lCaiu" aria-pressed="${fc.lCaiu}">Lula teve menos votos</button></div></div>
      <label class="filtro"><span>Variação de Flávio de no máximo <b id="dfmax-t"></b></span><input type="range" id="dfmax" min="-40" max="40" step="1" value="${fc.dfMax}"></label>
      <label class="filtro"><span>Variação de Lula de pelo menos <b id="dlmin-t"></b></span><input type="range" id="dlmin" min="-40" max="60" step="1" value="${fc.dlMin}"></label>
      <div class="filtro duas"><label><span>Eleitores (mínimo)</span><select id="minel">${[[0, 'qualquer'], [1000, '1 mil'], [10000, '10 mil'], [100000, '100 mil'], [1000000, '1 milhão']].map(([v, t]) => `<option value="${v}"${fc.minEl === v ? ' selected' : ''}>${t}</option>`).join('')}</select></label>
        <label><span>Ordenar por</span><select id="ordem">${[['queda_fv', 'Maior queda de Flávio (votos)'], ['queda_fp', 'Maior queda de Flávio (p.p.)'], ['ganho_lp', 'Maior ganho de Lula (p.p.)'], ['margem_l', 'Margem andou mais para Lula'], ['margem_f', 'Margem andou mais para Flávio'], ['queda_lv', 'Maior queda de Lula (votos)'], ['maiores', 'Mais eleitores']].map(([v, t]) => `<option value="${v}"${fc.ordem === v ? ' selected' : ''}>${t}</option>`).join('')}</select></label></div>
      <button type="button" class="botao-leve" id="limpar-fc">Limpar filtros</button>
    </section>
    <section class="cartao" id="cid-resumo"></section>
    <section class="cartao"><h2>Cada cidade é um ponto</h2>
      <div class="filtro"><span>Eixo horizontal</span>${seg('eixo', fc.eixo, [['outros', 'Outros candidatos no 1º'], ['abst', 'Variação do comparecimento']])}</div>
      <div id="g-cidades" class="grafico"></div>
      <p class="nota-pequena" id="g-cidades-nota"></p></section>
    <section class="cartao" id="cid-lista"></section>
    <section class="cartao" id="sec-extremas"></section>`;
  ligarFiltrosCidades(); atualizarCidades(); await secoesExtremas();
}
function ligarFiltrosCidades() {
  const atual = () => { $('#dfmax-t').textContent = fc.dfMax >= 40 ? 'qualquer' : pp(fc.dfMax); $('#dlmin-t').textContent = fc.dlMin <= -40 ? 'qualquer' : pp(fc.dlMin); };
  atual();
  document.querySelectorAll('[data-fc]').forEach((b) => (b.onclick = () => {
    const k = b.dataset.fc;
    if (b.dataset.v !== undefined) { fc[k] = b.dataset.v; b.parentElement.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === b))); }
    else { fc[k] = !fc[k]; b.setAttribute('aria-pressed', String(fc[k])); }
    fc.limite = 150; k === 'eixo' ? graficoCidades(filtrar()) : atualizarCidades();
  }));
  $('#dfmax').oninput = (e) => { fc.dfMax = +e.target.value; atual(); atualizarCidades(); };
  $('#dlmin').oninput = (e) => { fc.dlMin = +e.target.value; atual(); atualizarCidades(); };
  $('#minel').onchange = (e) => { fc.minEl = +e.target.value; atualizarCidades(); };
  $('#ordem').onchange = (e) => { fc.ordem = e.target.value; atualizarCidades(); };
  $('#limpar-fc').onclick = () => { Object.assign(fc, { venc: 'todos', virada: 'todas', fCaiu: false, lCaiu: false, dfMax: 40, dlMin: -40, minEl: 0, limite: 150 }); abaCidades(); };
}
function atualizarCidades() {
  const l = filtrar();
  const s = l.reduce((a, c) => { a.l1 += c.l1; a.f1 += c.f1; a.o1 += c.o1; a.l2 += c.l2; a.f2 += c.f2; a.c1 += c.comp1; a.c2 += c.comp2; a.apt += c.apt2; a.compCaiu += c.dC < 0; return a; }, { l1: 0, f1: 0, o1: 0, l2: 0, f2: 0, c1: 0, c2: 0, apt: 0, compCaiu: 0 });
  $('#cid-resumo').innerHTML = `<h2>${fmt.format(l.length)} ${l.length === 1 ? 'cidade' : 'cidades'} no filtro</h2>
    <ul class="saldos">
      <li><i class="ponto" style="background:${COR[22]}"></i><span>Flávio</span><b>${fmt.format(s.f1)} → ${fmt.format(s.f2)}</b><small>saldo ${sinal(s.f2 - s.f1)}</small></li>
      <li><i class="ponto" style="background:${COR[13]}"></i><span>Lula</span><b>${fmt.format(s.l1)} → ${fmt.format(s.l2)}</b><small>saldo ${sinal(s.l2 - s.l1)}</small></li>
      <li><i class="ponto" style="background:${COR.out}"></i><span>Outros candidatos no 1º turno</span><b>${fmt.format(s.o1)}</b></li>
      <li><i class="ponto" style="background:${COR.abst}"></i><span>Compareceram</span><b>${fmt.format(s.c1)} → ${fmt.format(s.c2)}</b><small>comparecimento caiu em ${fmt.format(s.compCaiu)} dessas cidades</small></li>
    </ul>`;
  const lista = l.slice(0, fc.limite);
  $('#cid-lista').innerHTML = `<h2>Cidades</h2>${lista.map((c) => `<button type="button" class="linha-cidade" data-ir='${JSON.stringify({ uf: c.uf, mun: c.cd })}'>
      <span class="lc-nome">${esc(c.nome)} <small>${c.uf}${c.v1w !== c.v2w ? ` · virou para ${c.v2w === '13' ? 'Lula' : 'Flávio'}` : ''}</small></span>
      <span class="lc-l t22">Flávio ${fmt.format(c.f1)} → ${fmt.format(c.f2)} <b>${sinal(c.dFv)}</b> <small>${pp(c.df)}</small></span>
      <span class="lc-l t13">Lula ${fmt.format(c.l1)} → ${fmt.format(c.l2)} <b>${sinal(c.dLv)}</b> <small>${pp(c.dl)}</small></span>
      <span class="lc-l sem">outros no 1º: ${fmt.format(c.o1)} · comparecimento ${sinal(c.dC)}</span></button>`).join('') || '<p class="nota-pequena">Nenhuma cidade com esses filtros.</p>'}
    ${l.length > fc.limite ? `<button type="button" class="botao-leve largo" id="mais-cid">Mostrar mais (${fmt.format(l.length - fc.limite)})</button>` : ''}`;
  $('#mais-cid')?.addEventListener('click', () => { fc.limite += 150; atualizarCidades(); });
  graficoCidades(l);
}
// Dispersão: no eixo horizontal, a parcela dos outros candidatos no 1º turno (ou a variação
// do comparecimento); no vertical, a variação da margem. Cidades do filtro em cor, demais em cinza.
function graficoCidades(filtradas) {
  const el = $('#g-cidades'); if (!el) return;
  el.innerHTML = '';
  const sel = new Set(filtradas.map((c) => c.uf + c.cd));
  const base = cidades.filter((c) => c.uf !== 'ZZ' && c.apt2 >= 500);
  const xv = fc.eixo === 'outros' ? (c) => c.po1 : (c) => Math.max(-30, Math.min(30, c.dabst));
  const W = el.clientWidth || 340, H = 260, m = { t: 10, r: 10, b: 32, l: 40 };
  const x = d3.scaleLinear().domain(fc.eixo === 'outros' ? [0, d3.max(base, xv) || 30] : [-30, 30]).nice().range([m.l, W - m.r]);
  const y = d3.scaleLinear().domain([-25, 45]).range([H - m.b, m.t]).clamp(true);
  const svg = d3.select(el).append('svg').attr('viewBox', `0 0 ${W} ${H}`).attr('class', 'svg-grafico');
  svg.append('g').attr('transform', `translate(0,${H - m.b})`).call(d3.axisBottom(x).ticks(5).tickFormat((v) => v + '%')).call((s) => s.selectAll('text').attr('font-size', 10));
  svg.append('g').attr('transform', `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(5).tickFormat((v) => (v > 0 ? '+' : '') + v)).call((s) => s.selectAll('text').attr('font-size', 10));
  svg.append('line').attr('x1', m.l).attr('x2', W - m.r).attr('y1', y(0)).attr('y2', y(0)).attr('stroke', 'currentColor').attr('opacity', 0.35);
  const ord = base.slice().sort((a, b) => sel.has(a.uf + a.cd) - sel.has(b.uf + b.cd));
  svg.append('g').selectAll('circle').data(ord).join('circle').attr('cx', (c) => x(xv(c))).attr('cy', (c) => y(c.dm))
    .attr('r', (c) => Math.max(1.2, Math.min(7, Math.sqrt(c.apt2) / 60)))
    .attr('fill', (c) => (sel.has(c.uf + c.cd) ? COR[c.v2w] : 'var(--borda)')).attr('opacity', (c) => (sel.has(c.uf + c.cd) ? 0.7 : 0.5))
    .append('title').text((c) => `${c.nome}/${c.uf}: margem ${pp(c.dm)}; outros no 1º ${pct(c.po1)}`);
  // Correlação simples entre os eixos (todas as cidades com 500+ eleitores).
  const xs = base.map(xv), ys = base.map((c) => c.dm), mx = d3.mean(xs), my = d3.mean(ys);
  const r = d3.sum(xs.map((v, i) => (v - mx) * (ys[i] - my))) / Math.sqrt(d3.sum(xs.map((v) => (v - mx) ** 2)) * d3.sum(ys.map((v) => (v - my) ** 2)));
  $('#g-cidades-nota').textContent = `Vertical: variação da margem Lula − Flávio (p.p.). Horizontal: ${fc.eixo === 'outros' ? 'votos dos outros candidatos no 1º turno (% dos válidos)' : 'variação do comparecimento entre turnos (%)'}. Correlação entre os dois eixos: r = ${r.toLocaleString('pt-BR', { maximumFractionDigits: 2 })}. Cidades com 500 eleitores ou mais; em cor, as do filtro (cor de quem venceu no 2º turno).`;
}
async function secoesExtremas() {
  if (!extremas) extremas = await json('dados/secoes_extremas.json?v=dev');
  const tipo = est.extTipo || 'queda_flavio';
  const noEscopo = (l) => (est.uf ? l[0] === est.uf : est.regiao ? (REGIOES[est.regiao] || []).includes(l[0]) : true);
  const linhas = extremas[tipo].filter(noEscopo).slice(0, 60);
  $('#sec-extremas').innerHTML = `<h2>Seções mais extremas do país</h2>
    <label class="filtro"><span class="visualmente-oculto">Tipo</span><select id="ext-tipo">${[['queda_flavio', 'Maiores quedas de Flávio (votos)'], ['margem_lula', 'Margem andou mais para Lula'], ['queda_lula', 'Maiores quedas de Lula (votos)'], ['margem_flavio', 'Margem andou mais para Flávio']].map(([v, t]) => `<option value="${v}"${v === tipo ? ' selected' : ''}>${t}</option>`).join('')}</select></label>
    <p class="nota-pequena">Seções com pelo menos 50 votantes nos dois turnos. ⚠ = a agregação de seções mudou entre os turnos (os eleitores não são os mesmos). ${est.uf || est.regiao ? 'Filtrado pelo recorte escolhido, entre as 300 mais extremas do país.' : ''}</p>
    ${linhas.map(([uf, mun, z, s, l1, f1, o1, c1, l2, f2, c2, dm, agr]) => `<button type="button" class="linha-cidade" data-ir='${JSON.stringify({ uf, mun, zona: z, secao: s })}'>
      <span class="lc-nome">${esc(titulo(extremas.nomes[`${uf}|${mun}`]))} <small>${uf} · zona ${z} · seção ${s}${agr ? ' ⚠' : ''}</small></span>
      <span class="lc-l t22">Flávio ${fmt.format(f1)} → ${fmt.format(f2)} <b>${sinal(f2 - f1)}</b></span>
      <span class="lc-l t13">Lula ${fmt.format(l1)} → ${fmt.format(l2)} <b>${sinal(l2 - l1)}</b></span>
      <span class="lc-l sem">outros no 1º: ${fmt.format(o1)} · votaram ${fmt.format(c1)} → ${fmt.format(c2)} · margem ${pp(dm)}</span></button>`).join('') || '<p class="nota-pequena">Nenhuma seção deste recorte entre as mais extremas do país.</p>'}`;
  $('#ext-tipo').onchange = (e) => { est.extTipo = e.target.value; secoesExtremas(); };
}

// ---------- aba 3: simulador ----------
const sim = { limite: 20 * 60, hipotese: 'manter', fora: new Set() };
function abaSimulador() {
  const opcoesUf = [...Object.keys(REGIOES).map((r) => [`r:${r}`, r]), ...Object.keys(NOME_UF).map((u) => [u, NOME_UF[u]])];
  $('#conteudo').innerHTML = `<section class="cartao"><h2>Simulador de cenários</h2>
    <p class="nota-pequena">Retire grupos de seções e veja quem venceria o 2º turno com os votos que sobram. Tudo é calculado com os boletins oficiais.</p>
    <label class="controle"><span>Contar só urnas que fecharam antes de <b id="lim-txt"></b> (Brasília)</span>
      <input type="range" id="lim" min="${17 * 60 + 5}" max="${20 * 60}" step="5" value="${sim.limite}"></label>
    <fieldset class="controle"><legend>Votos dados depois das 17h</legend>
      ${[['manter', 'Manter como foram apurados'], ['13', 'Hipótese extrema: todos foram para Lula, retirar'], ['22', 'Hipótese extrema: todos foram para Flávio, retirar']].map(([v, t]) => `<label class="opcao"><input type="radio" name="hip" value="${v}"${sim.hipotese === v ? ' checked' : ''}> ${t}</label>`).join('')}
    </fieldset>
    <details class="controle"><summary>Excluir estados ou regiões (${sim.fora.size})</summary><div class="chips">${opcoesUf.map(([v, t]) => `<button type="button" class="chip" data-fora="${v}" aria-pressed="${sim.fora.has(v)}">${t}</button>`).join('')}</div></details>
  </section><section class="cartao" id="sim-resultado"></section>`;
  const lim = $('#lim');
  lim.oninput = () => { sim.limite = +lim.value; calcularSim(); };
  document.querySelectorAll('input[name=hip]').forEach((r) => (r.onchange = () => { sim.hipotese = r.value; calcularSim(); }));
  document.querySelectorAll('[data-fora]').forEach((b) => (b.onclick = () => { const v = b.dataset.fora; sim.fora.has(v) ? sim.fora.delete(v) : sim.fora.add(v); b.setAttribute('aria-pressed', sim.fora.has(v)); b.closest('details').querySelector('summary').textContent = `Excluir estados ou regiões (${sim.fora.size})`; calcularSim(); }));
  calcularSim();
}
function calcularSim() {
  // Faixas de 5 min: o corte retira a faixa inteira que começa no limite, por isso "antes de".
  $('#lim-txt').textContent = sim.limite >= 20 * 60 ? 'qualquer horário (sem corte)' : hora(sim.limite);
  const excl = (uf) => sim.fora.has(uf) || Object.entries(REGIOES).some(([r, l]) => sim.fora.has('r:' + r) && l.includes(uf));
  let v13 = 0, v22 = 0, secoes = 0, removidas = 0, tardiosRet = 0;
  const media = R.pos17.fila.media || 0;
  for (const [uf, fx] of Object.entries(R.simulador)) {
    if (excl(uf)) continue;
    for (const [f, c] of Object.entries(fx)) {
      const m = f === 'sem' ? 0 : +f;
      // A faixa guarda o início (5 min); "até HH:MM" inclui as faixas que começam antes do limite.
      if (uf !== 'ZZ' && sim.limite < 20 * 60 && m >= sim.limite) { removidas += c.secoes; continue; }
      v13 += c['13']; v22 += c['22']; secoes += c.secoes;
      if (sim.hipotese !== 'manter' && uf !== 'ZZ') {
        // Votos depois das 17h: contados no log (seções após 17:15) ou estimados (fila 17:00–17:15).
        const t = (c.pos17 || 0) + (c.pos17_teto_extra || 0) + (m >= T17 && m < T1715 ? c.secoes * media : 0);
        tardiosRet += t;
      }
    }
  }
  if (sim.hipotese === '13') v13 -= tardiosRet; else if (sim.hipotese === '22') v22 -= tardiosRet;
  const tot = v13 + v22, l = tot ? (100 * v13) / tot : 0, venc = v13 >= v22 ? 'Lula' : 'Flávio Bolsonaro';
  $('#sim-resultado').innerHTML = `<h2>Resultado do cenário</h2>
    <div class="sim-placar"><div class="t13"><b>${pct(l, 2)}</b><span>Lula · ${fmt.format(Math.round(v13))}</span></div><div class="t22"><b>${pct(100 - l, 2)}</b><span>Flávio · ${fmt.format(Math.round(v22))}</span></div></div>
    <div class="barra-disputa"><span class="b13" style="width:${l}%"></span><span class="b22" style="width:${100 - l}%"></span><i class="meio"></i></div>
    <p class="sim-vencedor">Venceria: <b class="${v13 >= v22 ? 't13' : 't22'}">${venc}</b>, por ${fmt.format(Math.round(Math.abs(v13 - v22)))} votos.</p>
    <p class="nota-pequena">Seções contadas: ${fmt.format(secoes)}${removidas ? ` · retiradas pelo horário: ${fmt.format(removidas)}` : ''}${tardiosRet ? ` · votos depois das 17h retirados: ${fmt.format(Math.round(tardiosRet))} (parte estimada pela amostra)` : ''}. Resultado oficial: Lula ${pct((100 * R.br.t2['13']) / (R.br.t2['13'] + R.br.t2['22']), 2)}.</p>`;
}

// ---------- seletor de local, abas e montagem ----------
function seletorLocal() {
  const sel = $('#local');
  sel.innerHTML = `<option value="">Brasil</option><optgroup label="Regiões">${Object.keys(REGIOES).map((r) => `<option value="r:${r}">${r}</option>`).join('')}</optgroup><optgroup label="Estados">${Object.keys(NOME_UF).filter((u) => u !== 'ZZ').sort((a, b) => NOME_UF[a].localeCompare(NOME_UF[b], 'pt-BR')).map((u) => `<option value="${u}">${NOME_UF[u]}</option>`).join('')}<option value="ZZ">Exterior</option></optgroup>`;
  sel.value = est.uf || (est.regiao ? 'r:' + est.regiao : '');
  sel.onchange = () => (sel.value.startsWith('r:') ? irPara({ regiao: sel.value.slice(2) }) : sel.value ? irPara({ uf: sel.value }) : irPara({}));
}
async function buscaMunicipio() {
  const rot = $('#busca-rotulo');
  rot.hidden = !est.uf || est.uf === 'ZZ';
  if (rot.hidden) return;
  const d = await lerUf(est.uf);
  const nomes = Object.entries(d.municipios).map(([cd, m]) => [titulo(m.nome), Number(cd)]).sort((a, b) => a[0].localeCompare(b[0], 'pt-BR'));
  $('#lista-mun').innerHTML = nomes.map(([n]) => `<option value="${esc(n)}">`).join('');
  const inp = $('#busca');
  inp.value = '';
  inp.onchange = () => { const x = nomes.find(([n]) => n.toLowerCase() === inp.value.trim().toLowerCase()); if (x) irPara({ uf: est.uf, mun: x[1] }); };
}

async function desenhar() {
  document.querySelectorAll('.abas button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.aba === est.aba)));
  trilha(); seletorLocal(); buscaMunicipio();
  $('#conteudo').innerHTML = '<p class="carregando">Carregando…</p>';
  try {
    if (est.aba === 'turnos') await abaTurnos();
    else if (est.aba === 'horario') await abaHorario();
    else if (est.aba === 'cidades') await abaCidades();
    else abaSimulador();
  } catch (e) {
    $('#conteudo').innerHTML = `<div class="aviso erro">Não foi possível carregar estes dados (${esc(e.message)}).</div>`;
  }
}

function ligar() {
  document.querySelectorAll('.abas button').forEach((b) => (b.onclick = () => { est.aba = b.dataset.aba; evento('analise-aba', { aba: est.aba }); irPara({ regiao: est.regiao, uf: est.uf, mun: est.mun, zona: est.zona, secao: est.secao }); }));
  document.addEventListener('click', (ev) => {
    const alvo = ev.target.closest('[data-ir]');
    if (alvo) { irPara(JSON.parse(alvo.dataset.ir)); return; }
    const o = ev.target.closest('[data-ordem]');
    if (o) { const c = o.dataset.ordem; est.ordem = { col: c, asc: est.ordem.col === c ? !est.ordem.asc : c === 'nome' }; desenhar(); }
  });
  document.addEventListener('change', (ev) => { if (ev.target.id === 'metrica') { est.metrica = ev.target.value; desenhar(); } });
}

(async function iniciar() {
  lerTema(); ligar();
  try {
    [R] = await Promise.all([json('dados/resumo.json?v=dev'), carregarGeo()]);
  } catch (e) {
    $('#conteudo').innerHTML = `<div class="aviso erro">Não foi possível carregar os dados (${esc(e.message)}).</div>`;
    return;
  }
  $('#gerado').textContent = `Dados gerados em ${R.gerado}; logs lidos em ${R.pos17.gerado_logs || '–'}.`;
  desenhar();
})();
