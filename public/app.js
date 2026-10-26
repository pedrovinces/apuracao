// Painel de apuração do 2º turno presidencial de 2026.
// Fluxo: descobre a eleição no ele-c.json, lê BR + 27 UFs a cada 30 s e, sob demanda,
// os municípios (UF escolhida a cada 60 s; Brasil inteiro a cada 180 s).
/* global d3, topojson */
// O sufixo ?v=dev vira o código do commit na publicação (workflow): cada versão nova tem
// URLs novas e escapa do cache de 10 min que o GitHub Pages impõe.
import { diagnostico, usarDemo, modoAtual } from './tse.js?v=dev';
import { descobrirEleicao, lerResultado, lerMunicipios, publicado, normalizarNome } from './parser.js?v=dev';
import { criarMapa } from './mapa.js?v=dev';
import { iniciarMetricas, evento } from './metricas.js?v=dev';

const VERSAO = new URL(import.meta.url).searchParams.get('v') || 'dev';

const UFS = ['ac', 'al', 'am', 'ap', 'ba', 'ce', 'df', 'es', 'go', 'ma', 'mg', 'ms', 'mt', 'pa', 'pb', 'pe', 'pi', 'pr', 'rj', 'rn', 'ro', 'rr', 'rs', 'sc', 'se', 'sp', 'to'];
const NOME_UF = {
  ac: 'Acre', al: 'Alagoas', am: 'Amazonas', ap: 'Amapá', ba: 'Bahia', ce: 'Ceará', df: 'Distrito Federal', es: 'Espírito Santo',
  go: 'Goiás', ma: 'Maranhão', mg: 'Minas Gerais', ms: 'Mato Grosso do Sul', mt: 'Mato Grosso', pa: 'Pará', pb: 'Paraíba',
  pe: 'Pernambuco', pi: 'Piauí', pr: 'Paraná', rj: 'Rio de Janeiro', rn: 'Rio Grande do Norte', ro: 'Rondônia', rr: 'Roraima',
  rs: 'Rio Grande do Sul', sc: 'Santa Catarina', se: 'Sergipe', sp: 'São Paulo', to: 'Tocantins',
  zz: 'Exterior',
};
// Votos de brasileiros no exterior: no TSE a "UF" é zz e os "municípios" são cidades.
const EXT = 'zz';
// Regiões do IBGE. O TSE não publica arquivo por região: o resultado é a soma dos estados.
const REGIOES = {
  n: { nome: 'Norte', ufs: ['ac', 'am', 'ap', 'pa', 'ro', 'rr', 'to'] },
  ne: { nome: 'Nordeste', ufs: ['al', 'ba', 'ce', 'ma', 'pb', 'pe', 'pi', 'rn', 'se'] },
  co: { nome: 'Centro-Oeste', ufs: ['df', 'go', 'ms', 'mt'] },
  se: { nome: 'Sudeste', ufs: ['es', 'mg', 'rj', 'sp'] },
  s: { nome: 'Sul', ufs: ['pr', 'rs', 'sc'] },
};
const DO_UF = { ac: 'do', al: 'de', am: 'do', ap: 'do', ba: 'da', ce: 'do', df: 'do', es: 'do', go: 'de', ma: 'do', mg: 'de', ms: 'de', mt: 'de', pa: 'do', pb: 'da', pe: 'de', pi: 'do', pr: 'do', rj: 'do', rn: 'do', ro: 'de', rr: 'de', rs: 'do', sc: 'de', se: 'de', sp: 'de', to: 'do', zz: 'no' };
// A cor segue o número do candidato, nunca a posição na lista: se a liderança mudar,
// o vermelho continua sendo do 13 e o azul do 22.
const CAND = {
  13: { nome: 'Lula', partido: 'PT', cor: '#c81e1e' },
  22: { nome: 'Flávio Bolsonaro', partido: 'PL', cor: '#1d4ed8' },
};
const ORDEM = ['13', '22'];
const SATURA = 40; // pontos percentuais de margem em que a cor chega ao máximo
const MINIMO = 0.18; // intensidade mínima: vantagens pequenas também aparecem
// A CDN do TSE guarda cada versão dos arquivos por até ~60 s e ignora parâmetros na URL;
// abaixo disso ninguém que lê os arquivos públicos recebe antes. Por isso: o arquivo
// nacional (pequeno) é conferido a cada 5 s e, quando muda, as UFs são lidas na hora.
const T_BR = 5e3, T_COMPLETO = 60e3, T_MUN_UF = 60e3, T_MUN_BR = 180e3, T_MUN_MIN = 30e3;
const T_RETENTA = 30e3, T_VERSAO = 60e3, PARALELO = 6;
// Fechamento das urnas: 17h de Brasília (UTC-3, sem horário de verão) de 25/10/2026.
// ?fechamento=<ISO> existe para testar a contagem em qualquer horário.
// Prorrogado para 19h por decisão do STF (ministro Cristiano Zanin) no dia da eleição.
const FECHAMENTO = new Date(new URLSearchParams(location.search).get('fechamento') || '2026-10-25T19:00:00-03:00').getTime();
const FECHAMENTO_ORIGINAL = new Date('2026-10-25T17:00:00-03:00').getTime();
const PARADO_MIN = 10; // minutos sem nova versão do TSE para avisar que os dados estão parados

const params = new URLSearchParams(location.search);
const DEMO = params.get('demo') === '1';
const $ = (s) => document.querySelector(s);

const est = {
  eleicao: null, descoberta: null, br: null, ufs: {}, mun: new Map(),
  munCfg: [], tsePorIbge: new Map(), semLigacao: [],
  nivel: params.get('nivel') === 'municipios' ? 'municipios' : 'estados',
  uf: [...UFS, EXT].includes((params.get('uf') || '').toLowerCase()) ? params.get('uf').toLowerCase() : null,
  regiao: REGIOES[(params.get('regiao') || '').toLowerCase()] ? params.get('regiao').toLowerCase() : null,
  ultimaLeitura: null, ultimaConferencia: null, assinaturaBr: null, ultimoCompleto: 0, ultimaCargaMun: 0,
  statusBr: null, limiteTabela: 60,
};

// ---------- formatação ----------
const fmtInt = new Intl.NumberFormat('pt-BR');
const fmtCompacto = new Intl.NumberFormat('pt-BR', { notation: 'compact', maximumFractionDigits: 1 });
const pct = (v, casas = 2) => (v == null ? '–' : v.toLocaleString('pt-BR', { minimumFractionDigits: casas, maximumFractionDigits: casas }) + '%');
const horaBrasilia = (d) => d.toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour12: false });
const nomeCand = (c) => CAND[c.n]?.nome || tituloCaixa(c.nome);
// O TSE manda nomes em caixa alta; preposições ficam minúsculas ("Cachoeira dos Índios").
const tituloCaixa = (s) => String(s).toLowerCase().replace(/(^|\s)\S/g, (m) => m.toUpperCase()).replace(/ (D[aeo]s?|E) /g, (m) => m.toLowerCase());
const escapar = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const doNumero = (r, n) => r?.cand.find((c) => c.n === n);

// ---------- cores ----------
let tema = {};
function lerTema() {
  const css = getComputedStyle(document.documentElement);
  tema = { neutro: css.getPropertyValue('--neutro').trim(), sem: css.getPropertyValue('--semdados').trim() };
}
function cor(r) {
  if (!r || !publicado(r) || r.totalCand <= 0 || r.cand.length < 2) return tema.sem;
  const [a, b] = r.cand;
  const margem = a.pct - b.pct;
  if (margem <= 0) return tema.neutro;
  const t = MINIMO + (1 - MINIMO) * Math.min(1, margem / SATURA);
  return d3.interpolateRgb(tema.neutro, CAND[a.n]?.cor || '#777')(t);
}

// ---------- dados por feição do mapa ----------
const resultadoUf = (uf) => est.ufs[uf.toLowerCase()]?.resultado || null;
// Soma os arquivos estaduais da região no mesmo formato de um resultado do TSE.
// Seções apuradas = totalizadas / total das seções dos estados da região.
function resultadoRegiao(id) {
  const rs = REGIOES[id].ufs.map(resultadoUf).filter(Boolean);
  if (!rs.length) return null;
  // Estados sem arquivo lido (recusa do TSE no pico): a soma fica parcial e isso é avisado.
  const faltando = REGIOES[id].ufs.filter((u) => !resultadoUf(u)).map((u) => u.toUpperCase());
  const soma = (f) => rs.reduce((t, r) => t + (f(r) || 0), 0);
  const votos = {};
  for (const r of rs) for (const c of r.cand) votos[c.n] = (votos[c.n] || 0) + c.votos;
  const totalCand = Object.values(votos).reduce((a, b) => a + b, 0);
  const cand = Object.entries(votos).map(([n, v]) => ({ n, nome: rs[0].cand.find((c) => c.n === n)?.nome || n, votos: v, pct: totalCand ? (100 * v) / totalCand : 0, eleito: false }))
    .sort((a, b) => b.votos - a.votos || Number(a.n) - Number(b.n));
  const ts = soma((r) => r.secoesTotal), st = soma((r) => r.secoesApuradas);
  const comparec = soma((r) => (r.eleitores != null && r.abstencao != null ? r.eleitores - r.abstencao : 0));
  return {
    cand, totalCand, pst: ts ? (100 * st) / ts : 0, secoesTotal: ts, secoesApuradas: st,
    eleitores: soma((r) => r.eleitores), abstencao: soma((r) => r.abstencao),
    brancos: soma((r) => r.brancos), nulos: soma((r) => r.nulos), comparecimento: comparec, regiao: true, faltando,
  };
}
function resultadoMun(f) {
  const tse = est.tsePorIbge.get(f.properties.ibge);
  return tse ? est.mun.get(tse)?.resultado || null : null;
}

// ---------- mapa ----------
let geo, mapa;
async function carregarGeo() {
  const r = await fetch('geo/brasil.topo.json?v=dev');
  const topo = await r.json();
  geo = {
    municipios: topojson.feature(topo, topo.objects.municipios),
    estados: topojson.feature(topo, topo.objects.estados),
  };
  // Ligação por nome (quando o TSE não traz o código IBGE): NOME NORMALIZADO + UF.
  geo.porNome = new Map(geo.municipios.features.map((f) => [normalizarNome(f.properties.nome) + '|' + f.properties.uf.toLowerCase(), f.properties.ibge]));
  geo.ibges = new Set(geo.municipios.features.map((f) => f.properties.ibge));
}

function iniciarMapa() {
  mapa = criarMapa($('#mapa'), geo, {
    passar(tipo, f, ev) { mostrarDica(ficha(tipo, f), ev); },
    sair: esconderDica,
    clicar(tipo, f, ev) {
      esconderDica();
      if (tipo === 'uf') {
        // Toque ou clique num estado: abre os municípios dele e mostra o resumo no painel.
        escolherUf(f.properties.uf.toLowerCase());
        if (ev.pointerType !== 'mouse') abrirPainel(ficha('uf', f));
      } else {
        abrirPainel(ficha('mun', f));
      }
    },
    zoom(ampliado) { $('#zoom-reset').hidden = !ampliado; },
  });
  $('#zoom-reset').onclick = () => mapa.restaurarZoom();
}

function aplicarVista() {
  const munis = est.nivel === 'municipios' || !!est.uf;
  const exterior = est.uf === EXT;
  // O exterior não tem mapa: no lugar dele entra um resumo com os números.
  $('#mapa').hidden = exterior; $('#legenda').hidden = exterior; $('#dica-uso').hidden = exterior;
  $('#exterior-resumo').hidden = !exterior;
  if (exterior) $('#zoom-reset').hidden = true;
  else mapa.mostrar({ modo: est.nivel, uf: est.uf ? est.uf.toUpperCase() : null, regiao: !est.uf && est.regiao ? REGIOES[est.regiao].ufs.map((u) => u.toUpperCase()) : null });
  $('#voltar').hidden = !est.uf && !est.regiao;
  $('#voltar').textContent = est.uf && est.regiao ? `← ${REGIOES[est.regiao].nome}` : '← Brasil';
  const reg = !est.uf && est.regiao ? REGIOES[est.regiao] : null;
  $('#regiao-resumo').hidden = !reg && !(est.uf && est.uf !== EXT);
  $('#titulo-mapa').textContent = exterior ? 'Votos no exterior' : est.uf ? NOME_UF[est.uf] : reg ? `Região ${reg.nome}` : munis ? 'Brasil por município' : 'Brasil por estado';
  $('#dica-uso').textContent = est.uf
    ? 'Toque num município para ver os números. Use dois dedos para ampliar.'
    : munis ? 'Toque num município para ver os números. Use dois dedos para ampliar.' : 'Toque num estado para ver os municípios. Use dois dedos para ampliar.';
  document.querySelectorAll('.segmentado button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.nivel === est.nivel)));
  $('#uf').value = est.uf || (est.regiao ? 'reg:' + est.regiao : '');
  // O endereço reflete a escolha, para compartilhar o link já no recorte certo.
  const p = new URLSearchParams(location.search);
  est.uf ? p.set('uf', est.uf.toUpperCase()) : p.delete('uf');
  !est.uf && est.regiao ? p.set('regiao', est.regiao.toUpperCase()) : p.delete('regiao');
  est.nivel === 'municipios' ? p.set('nivel', 'municipios') : p.delete('nivel');
  p.delete('_v'); // marca usada só para furar o cache do HTML na troca de versão
  history.replaceState(null, '', location.pathname + (p.toString() ? '?' + p : '') + location.hash);
  pintarMapa();
  desenharTabela();
  desenharExterior();
  desenharRegioes();
}

// Resumo da região escolhida (no lugar de destaque do mapa) e tabela das cinco regiões
// na visão do Brasil. Mesmas regras de contagem e brilho das outras tabelas.
// Indicador gráfico da apuração: barra com seções totalizadas / total (estado, região, exterior).
function barraApuracao(r) {
  if (!r || !publicado(r)) return '';
  const sec = r.secoesTotal ? `<small>${fmtInt.format(r.secoesApuradas)} de ${fmtInt.format(r.secoesTotal)} seções</small>` : '';
  return `<div class="apur-regiao"><div class="apur-regiao-rotulo"><span>Seções apuradas</span><b>${pct(r.pst)}</b></div><div class="barra-apurado grossa"><span style="width:${Math.min(100, r.pst)}%"></span></div>${sec}</div>`;
}

function desenharRegioes() {
  const reg = !est.uf && est.regiao ? est.regiao : null;
  if (est.uf && est.uf !== EXT) {
    const r = resultadoUf(est.uf);
    $('#regiao-resumo').innerHTML = barraApuracao(r) + fichaHtml(NOME_UF[est.uf], 'Estado', r);
  }
  if (reg) {
    const r = resultadoRegiao(reg);
    const falta = r?.faltando?.length ? ` · faltam dados de ${r.faltando.join(', ')} (soma parcial)` : '';
    // Indicador gráfico da apuração da região: barra com seções totalizadas / total.
    $('#regiao-resumo').innerHTML = barraApuracao(r) + fichaHtml(`Região ${REGIOES[reg].nome}`, `${REGIOES[reg].ufs.length} estados${falta}`, r);
  }
  const cartao = $('#cartao-regioes');
  cartao.hidden = !!est.uf || !!est.regiao;
  if (cartao.hidden) return;
  const linhas = Object.entries(REGIOES).map(([id, g]) => {
    const r = resultadoRegiao(id);
    return { chave: 'reg-' + id, nome: g.nome + (r?.faltando?.length ? '*' : ''), regiao: id, r };
  });
  linhas.sort((a, b) => (b.r?.totalCand || 0) - (a.r?.totalCand || 0));
  $('#tabela-regioes thead').innerHTML = cabecalho('Região');
  $('#tabela-regioes tbody').innerHTML = linhasHtml('regioes', linhas);
}
function cabecalho(local) {
  return `<tr><th class="col-local">${local}</th><th class="col-apur">Apur.</th>${ORDEM.map((n) => `<th class="col-c">${CAND[n].nome.split(' ')[0]}</th>`).join('')}<th class="col-dif">Dif.</th></tr>`;
}

function pintarMapa() {
  mapa?.colorir({ uf: (f) => cor(resultadoUf(f.properties.uf)), mun: (f) => cor(resultadoMun(f)) });
}

function desenharLegenda() {
  const rampa = (n) => `<span class="rampa"><i style="background:linear-gradient(90deg, ${d3.interpolateRgb(tema.neutro, CAND[n].cor)(MINIMO)}, ${CAND[n].cor})"></i>${CAND[n].nome} à frente</span>`;
  $('#legenda').innerHTML = `${rampa('13')}${rampa('22')}<span>cor mais forte = vantagem maior (satura em ${SATURA} pontos)</span><span><i class="caixa" style="background:${tema.sem}"></i>sem dados</span>`;
}

// ---------- dica e painel ----------
function ficha(tipo, f) {
  let titulo, sub, r, acao = '';
  if (tipo === 'uf') {
    const uf = f.properties.uf.toLowerCase();
    r = resultadoUf(uf); titulo = NOME_UF[uf]; sub = 'Estado';
  } else {
    r = resultadoMun(f); titulo = f.properties.nome; sub = f.properties.uf;
    if (!est.tsePorIbge.has(f.properties.ibge)) sub += ' · sem correspondência no TSE';
  }
  if (tipo === 'uf' && est.uf !== f.properties.uf.toLowerCase()) acao = `<button type="button" class="ficha-acao" data-uf="${f.properties.uf.toLowerCase()}">Ver municípios</button>`;
  return (tipo === 'uf' ? barraApuracao(r) : '') + fichaHtml(titulo, sub, r, acao);
}
function fichaHtml(titulo, sub, r, acao = '') {
  return `<div class="ficha-titulo">${escapar(titulo)}</div><div class="ficha-sub">${escapar(sub)}${r ? ' · ' + pct(r.pst) + ' das seções apuradas' : ''}</div>${linhasCand(r)}${acao}`;
}

// Cartão do exterior abaixo do placar e resumo no lugar do mapa quando ele é escolhido.
function desenharExterior() {
  const r = resultadoUf(EXT);
  const ok = publicado(r);
  const partes = ok ? ORDEM.map((n) => { const c = doNumero(r, n); return c ? `<b style="color:var(--t${n})">${CAND[n].nome.split(' ')[0]} ${numHtml('ext|' + n, c.pct, 'pct1')}</b>` : ''; }).join(' · ') : 'aguardando o TSE';
  const b = attrsBrilho(ok ? marca('ext|cartao', r.cand.map((c) => pct(c.pct, 1)).join() + pct(r.pst, 0)) : null);
  $('#exterior-cartao').innerHTML = `<span class="ext-rotulo">Votos no exterior</span><span class="ext-numeros${b.cls}"${b.estilo}>${partes}${r ? ` <small>· ${pct(r.pst, 0)} apurado</small>` : ''}</span><span class="ext-seta" aria-hidden="true">›</span>`;
  $('#exterior-cartao').setAttribute('aria-pressed', String(est.uf === EXT));
  if (est.uf === EXT) {
    const cidades = est.munCfg.filter((m) => m.uf === EXT).length;
    $('#exterior-resumo').innerHTML = barraApuracao(r) + fichaHtml('Brasileiros que votam fora do país', `${cidades ? fmtInt.format(cidades) + ' cidades · ' : ''}${r?.eleitores ? fmtInt.format(r.eleitores) + ' eleitores' : ''}`, r)
      + '<p class="ficha-sub">Os votos do exterior já entram no total nacional do placar. Abaixo, o resultado por cidade.</p>';
  }
}
function linhasCand(r) {
  if (!r || !publicado(r)) {
    const carregando = tipoCarregando();
    return `<div class="ficha-sub">${carregando || 'Sem dados publicados ainda.'}</div>`;
  }
  return ORDEM.map((n) => {
    const c = doNumero(r, n);
    if (!c) return '';
    return `<div class="ficha-linha"><span>${escapar(nomeCand(c))}${c.eleito ? ' <span class="selo" style="background:' + CAND[n].cor + '">ELEITO</span>' : ''}</span><b style="color:var(--t${n})">${pct(c.pct)}</b>
      <span class="mini"><span style="width:${c.pct}%;background:${CAND[n].cor}"></span></span><small>${fmtInt.format(c.votos)} votos</small></div>`;
  }).join('');
}
function tipoCarregando() {
  if (!est.eleicao) return 'Procurando a eleição no TSE…';
  if (est.carregandoUfs) return 'Carregando os dados do TSE…';
  return carga.ativa ? 'Lendo os municípios no TSE…' : '';
}
function mostrarDica(html, ev) {
  const d = $('#dica');
  d.innerHTML = html; d.hidden = false;
  const { innerWidth: W, innerHeight: H } = window;
  const w = d.offsetWidth, h = d.offsetHeight;
  let x = ev.clientX + 16, y = ev.clientY + 16;
  if (x + w > W - 8) x = ev.clientX - w - 16;
  if (y + h > H - 8) y = ev.clientY - h - 16;
  d.style.left = Math.max(8, x) + 'px'; d.style.top = Math.max(8, y) + 'px';
}
function esconderDica() { $('#dica').hidden = true; }
function abrirPainel(html) {
  evento('abriu-detalhe');
  $('#painel-conteudo').innerHTML = html;
  $('#painel').hidden = false;
}
function fecharPainel() { $('#painel').hidden = true; }

// ---------- sinalização de mudança ----------
// Quando um número muda, a célula ganha um brilho que some em 2,4 s. Como a tabela é
// redesenhada inteira (às vezes a cada 0,7 s, durante a carga dos municípios), guardamos
// quando cada valor mudou e retomamos a animação do ponto em que estava, com atraso
// negativo; sem isso, o brilho reiniciaria ou seria cortado a cada redesenho.
const DUR_BRILHO = 2400;
const marcas = new Map(); // chave -> { texto, t }
const reduzMovimento = window.matchMedia('(prefers-reduced-motion: reduce)');
function marca(chave, texto) {
  const agora = performance.now();
  const ant = marcas.get(chave);
  if (!ant) { marcas.set(chave, { texto, t: -Infinity }); return null; } // 1ª vez: nada a sinalizar
  if (ant.texto !== texto) { marcas.set(chave, { texto, t: agora }); return 0; }
  const passou = agora - ant.t;
  return passou < DUR_BRILHO ? passou : null;
}
// Atributos HTML da sinalização: classe e o atraso que continua a animação em curso.
function attrsBrilho(passou, classe = 'mudou') {
  if (passou == null) return { cls: '', estilo: '' };
  return { cls: ' ' + classe, estilo: passou > 0 ? ` style="animation-delay:-${Math.round(passou)}ms"` : '' };
}
// Para elementos fixos do placar: reinicia a animação no próprio elemento.
function brilhar(el, chave, texto) {
  const passou = marca(chave, texto);
  if (passou === 0) { el.classList.remove('mudou'); void el.offsetWidth; el.classList.add('mudou'); }
}
// ---------- contagem ----------
// Número que muda conta do valor antigo ao novo em 1,2 s: arranca rápido e freia no fim
// (como um painel de apuração), em vez de trocar de uma vez. Cada contagem é guardada por
// chave com início e fim; um laço único de animação atualiza todos os elementos marcados
// com data-conta. Se a tabela for redesenhada no meio, o HTML novo já nasce com o valor
// intermediário certo e a contagem segue sem pulo.
const DUR_CONTA = 1200;
const contas = new Map(); // chave -> { de, para, t }
const FORMATOS = {
  pct2: (v) => pct(v, 2), pct1: (v) => pct(v, 1), pct0: (v) => pct(v, 0),
  int: (v) => fmtInt.format(Math.round(v)), comp: (v) => fmtCompacto.format(Math.round(v)),
  mais: (v) => '+' + fmtInt.format(Math.round(v)),
};
const desacelera = (k) => 1 - Math.pow(1 - k, 3);
function valorEm(c, agora) {
  const k = (agora - c.t) / DUR_CONTA;
  return k >= 1 ? c.para : c.de + (c.para - c.de) * desacelera(Math.max(0, k));
}
// Registra o valor atual; devolve a contagem em curso (ou null se não há o que animar).
function contagem(chave, valor) {
  if (valor == null || !Number.isFinite(valor)) { contas.delete(chave); return null; }
  const agora = performance.now();
  const c = contas.get(chave);
  if (!c) { contas.set(chave, { de: valor, para: valor, t: -Infinity }); return null; }
  if (c.para !== valor) {
    // Parte de onde a contagem anterior estava, para não voltar atrás num salto.
    const n = { de: valorEm(c, agora), para: valor, t: agora };
    contas.set(chave, n);
    return reduzMovimento.matches ? null : n;
  }
  return !reduzMovimento.matches && agora - c.t < DUR_CONTA ? c : null;
}
// HTML de um número que conta: texto do instante atual + dados para o laço de animação.
function numHtml(chave, valor, tipo, tag = 'span', classe = '') {
  const c = contagem(chave, valor);
  const cls = classe ? ` class="${classe}"` : '';
  if (!c) return `<${tag}${cls}>${FORMATOS[tipo](valor)}</${tag}>`;
  setTimeout(animarContas);
  return `<${tag}${cls} data-conta data-de="${c.de}" data-para="${c.para}" data-t="${c.t}" data-tipo="${tipo}">${FORMATOS[tipo](valorEm(c, performance.now()))}</${tag}>`;
}
// Mesma coisa para um elemento que já existe (placar).
function numEl(el, chave, valor, tipo) {
  const c = contagem(chave, valor);
  if (!c) { delete el.dataset.conta; el.textContent = FORMATOS[tipo](valor); return; }
  Object.assign(el.dataset, { conta: '', de: c.de, para: c.para, t: c.t, tipo });
  el.textContent = FORMATOS[tipo](valorEm(c, performance.now()));
  animarContas();
}
let contando = false;
function animarContas() {
  if (contando) return;
  contando = true;
  const passo = () => {
    const agora = performance.now();
    let ativos = 0;
    for (const el of document.querySelectorAll('[data-conta]')) {
      const c = { de: Number(el.dataset.de), para: Number(el.dataset.para), t: Number(el.dataset.t) };
      el.textContent = FORMATOS[el.dataset.tipo](valorEm(c, agora));
      if (agora - c.t >= DUR_CONTA) delete el.dataset.conta; else ativos++;
    }
    if (ativos) requestAnimationFrame(passo); else contando = false;
  };
  requestAnimationFrame(passo);
}

// ---------- placar ----------
function desenharPlacar() {
  const r = est.br?.resultado || null;
  const ok = publicado(r);
  for (const n of ORDEM) {
    const el = document.querySelector(`.cand[data-n="${n}"]`);
    const c = doNumero(r, n);
    const alvo = el.querySelector('.cand-pct');
    // Antes da divulgação, um 0,00% apagado: o traço solto em fonte grande parecia defeito.
    if (ok && c) numEl(alvo, 'placar|pct|' + n, c.pct, 'pct2'); else { delete alvo.dataset.conta; alvo.textContent = '0,00%'; }
    alvo.classList.toggle('vazio', !(ok && c));
    if (ok && c) brilhar(alvo, 'placar|pct|' + n, pct(c.pct));
    // Com o resultado definido, a foto de quem não foi eleito esmaece.
    el.querySelector('.cand-foto').classList.toggle('perdeu', !!(ok && r.cand.some((x) => x.eleito) && c && !c.eleito));
    const votos = el.querySelector('.cand-votos');
    if (ok && c) {
      if (!votos.querySelector('.n')) votos.innerHTML = '<span class="n"></span> votos<span class="selo-lugar"></span>';
      numEl(votos.querySelector('.n'), 'placar|votos|' + n, c.votos, 'int');
      votos.querySelector('.selo-lugar').innerHTML = c.eleito ? ' <span class="selo">ELEITO</span>' : '';
    } else votos.innerHTML = '&nbsp;';
  }
  desenharDefinicao(r, ok);
  const c13 = doNumero(r, '13'), c22 = doNumero(r, '22');
  $('#barra-disputa .b13').style.width = ok && c13 ? c13.pct + '%' : '0';
  $('#barra-disputa .b22').style.width = ok && c22 ? c22.pct + '%' : '0';
  if (!$('#apurado-txt b')) $('#apurado-txt').innerHTML = 'Seções apuradas: <b>–</b>';
  if (r) { numEl($('#apurado-txt b'), 'placar|pst', r.pst, 'pct2'); brilhar($('#apurado-txt b'), 'placar|pst', pct(r.pst)); }
  $('#apurado-barra').style.width = (r?.pst || 0) + '%';
  if (ok && r.cand.length >= 2) {
    const [a, b] = r.cand;
    const dif = a.votos - b.votos;
    // A chave inclui o líder: se a liderança virar, a diferença recomeça do zero, sem contar "através" dele.
    $('#diferenca-txt').innerHTML = dif > 0 ? `<b style="color:var(--t${a.n})">${nomeCand(a)}</b> ${numHtml('placar|dif|' + a.n, dif, 'mais', 'span', 'n')}` : 'Empate';
    const n = $('#diferenca-txt .n');
    if (n) { const passou = marca('placar|dif', fmtInt.format(dif)); if (passou != null) { n.classList.add('mudou'); if (passou > 0) n.style.animationDelay = `-${Math.round(passou)}ms`; } }
  } else $('#diferenca-txt').textContent = '';

  // A diferença já aparece no placar fixo; aqui ficam os números de apoio, compactos.
  const itens = [];
  const item = (t, p, v) => [t, `${numHtml('num|p|' + t, p, 'pct1')} ${numHtml('num|v|' + t, v, 'comp', 'small')}`, pct(p, 1) + fmtCompacto.format(v)];
  if (ok && r.abstencao != null) itens.push(item('Abstenção', r.pAbstencao, r.abstencao));
  if (ok && r.brancos != null) itens.push(item('Brancos', r.pBrancos, r.brancos));
  if (ok && r.nulos != null) itens.push(item('Nulos', r.pNulos, r.nulos));
  const horas = [];
  if (r?.dg) horas.push(`TSE: <b>${escapar(r.hg || '')}</b> de ${escapar(r.dg)}`);
  $('#horarios').innerHTML = horas.join(' · ');
  $('#numeros').innerHTML = itens.map(([t, v, texto]) => {
    const b = attrsBrilho(marca('num|' + t, texto));
    return `<div class="${b.cls.trim()}"${b.estilo}><dt>${t}</dt><dd>${v}</dd></div>`;
  }).join('');

  const pil = $('#estado-ao-vivo');
  pil.className = 'pilula';
  if (!est.eleicao) pil.textContent = 'procurando eleição';
  else if (!ok) pil.textContent = 'aguardando o TSE';
  else if (r.pst >= 100 || r.totalizada) { pil.textContent = 'totalizado'; pil.classList.add('final'); }
  else { pil.textContent = 'ao vivo'; pil.classList.add('vivo'); }
}

// Faixa de definição no placar. Duas situações, com graus de certeza diferentes:
// o TSE marcou o eleito (oficial) ou a conta fecha antes disso: a vantagem do líder já é
// maior que o número de eleitores das seções ainda não apuradas, então nem que todos
// votassem no segundo colocado ele alcançaria o primeiro.
function desenharDefinicao(r, ok) {
  const el = $('#definicao');
  if (!ok || r.cand.length < 2) { el.hidden = true; return; }
  const [a, b] = r.cand;
  const eleito = r.cand.find((c) => c.eleito);
  const vantagem = a.votos - b.votos;
  const matematico = !eleito && r.naoApurados != null && r.pst < 100 && vantagem > r.naoApurados;
  if (!eleito && !matematico) { el.hidden = true; return; }
  const c = eleito || a;
  if (c.n === '22') festejar(!!eleito);
  el.hidden = false;
  el.className = 'definicao ' + (eleito ? 'oficial' : 'calculo');
  el.style.setProperty('--cor', CAND[c.n]?.cor || '#555');
  el.innerHTML = eleito
    ? `<b>${escapar(nomeCand(c))} está eleito presidente</b><span>confirmado pelo TSE</span>`
    : `<b>Matematicamente definido: ${escapar(nomeCand(c))}</b><span class="longo">vantagem de ${fmtInt.format(vantagem)} votos é maior que os ${fmtInt.format(r.naoApurados)} eleitores das seções que faltam · aguardando o TSE</span><span class="curto">vantagem já supera todos os eleitores que faltam · aguardando o TSE</span>`;
  if (c.n === '22') el.insertAdjacentHTML('beforeend', '<button type="button" class="rever-festa">🎆 Rever</button>');
  el.title = `Vantagem de ${fmtInt.format(vantagem)} votos; eleitores nas seções não apuradas: ${fmtInt.format(r.naoApurados ?? 0)}.`;
}

// Comemoração da vitória do 22: uma vez por estado (definido / confirmado) em cada aparelho.
// No demo a lembrança dura só a aba, para dar para testar de novo.
function festejar(oficial, forcar = false) {
  const chave = `festa|${est.eleicao?.cd}|${oficial ? 'oficial' : 'calculo'}`;
  const guarda = DEMO ? sessionStorage : localStorage;
  try { if (!forcar && guarda.getItem(chave)) return; guarda.setItem(chave, '1'); } catch { /* sem armazenamento: festeja mesmo assim */ }
  import('./festa.js?v=dev').then((m) => m.comemorar({ oficial, versao: VERSAO }));
  evento('festa', { tipo: oficial ? 'oficial' : 'calculo' });
}

// Contagem regressiva até o fechamento das urnas; depois, "aguardando o TSE"; some quando
// os primeiros números aparecem.
function desenharContagem() {
  const el = $('#contagem');
  const publicadoBr = publicado(est.br?.resultado);
  if (publicadoBr || DEMO) { el.hidden = true; return; }
  el.hidden = false;
  const falta = FECHAMENTO - Date.now();
  if (falta > 0) {
    const t = Math.floor(falta / 1000);
    const hh = String(Math.floor(t / 3600)).padStart(2, '0'), mm = String(Math.floor((t % 3600) / 60)).padStart(2, '0'), ss = String(t % 60).padStart(2, '0');
    if (!el.querySelector('.relogio')) el.innerHTML = `<span class="contagem-rotulo">As urnas fecham em</span><span class="relogio" role="timer"></span><span class="contagem-sub">às 19h de Brasília (votação prorrogada pelo STF). O TSE começa a divulgar o resultado logo depois.</span>`;
    el.querySelector('.relogio').innerHTML = `${hh}<i>:</i>${mm}<i>:</i>${ss}`;
    el.classList.remove('fechadas');
  } else {
    if (!el.classList.contains('fechadas')) {
      el.classList.add('fechadas');
      el.innerHTML = `<span class="contagem-rotulo">Urnas fechadas</span><span class="aguardando">Aguardando a primeira divulgação do TSE<span class="pontos" aria-hidden="true"><i>.</i><i>.</i><i>.</i></span></span><span class="contagem-sub">O painel confere o TSE a cada 5 s e mostra os números assim que saírem.</span>`;
    }
  }
}

function aviso(msg, erro = false) {
  const a = $('#aviso');
  a.hidden = !msg; a.textContent = msg || ''; a.classList.toggle('erro', erro);
}

// ---------- tabela ----------
function desenharTabela() {
  const thead = $('#tabela thead'), tbody = $('#tabela tbody');
  thead.innerHTML = cabecalho(est.uf === EXT ? 'Cidade' : est.uf ? 'Município' : 'Estado');
  let linhas;
  if (est.uf) {
    $('#titulo-tabela').textContent = est.uf === EXT ? 'Cidades no exterior' : `Municípios ${DO_UF[est.uf]} ${NOME_UF[est.uf]}`;
    linhas = est.munCfg.filter((m) => m.uf === est.uf).map((m) => ({ chave: m.cd, nome: tituloCaixa(m.nome), r: est.mun.get(m.cd)?.resultado || null }));
  } else if (est.regiao) {
    $('#titulo-tabela').textContent = `Estados da região ${REGIOES[est.regiao].nome}`;
    linhas = REGIOES[est.regiao].ufs.map((uf) => ({ chave: uf, nome: NOME_UF[uf], uf, r: resultadoUf(uf) }));
  } else {
    $('#titulo-tabela').textContent = 'Por estado';
    linhas = [...UFS, EXT].map((uf) => ({ chave: uf, nome: NOME_UF[uf], uf, r: resultadoUf(uf) }));
  }
  linhas.sort((a, b) => (b.r?.totalCand || 0) - (a.r?.totalCand || 0) || a.nome.localeCompare(b.nome, 'pt-BR'));
  const total = linhas.length;
  // Quantos locais já têm seções apuradas: explica os "–" de quem o TSE ainda não publicou.
  const comApuracao = linhas.filter((l) => l.r && l.r.pst > 0).length;
  const resumo = $('#resumo-tabela');
  if (est.uf && publicado(est.br?.resultado)) {
    const nome = est.uf === EXT ? 'cidades' : 'municípios';
    resumo.hidden = false;
    // Antes de algum local chegar, "0 com apuração" seria falso: ainda não foram lidos.
    const lidos = linhas.filter((l) => l.r).length;
    resumo.textContent = !lidos ? `Carregando os ${nome} do TSE…`
      : comApuracao < total
        ? `${fmtInt.format(comApuracao)} de ${fmtInt.format(total)} ${nome} com apuração${carga.ativa ? ' (lendo os demais…)' : `; ${est.uf === EXT ? 'as demais' : 'os demais'} aparecem com – até o TSE publicar.`}`
        : `${est.uf === EXT ? 'Todas as' : 'Todos os'} ${fmtInt.format(total)} ${nome} com apuração.`;
  } else resumo.hidden = true;
  if (est.uf) linhas = linhas.slice(0, est.limiteTabela);
  tbody.innerHTML = linhasHtml(est.uf || 'br', linhas);
  $('#mais').hidden = !est.uf || total <= est.limiteTabela;
  $('#mais').textContent = `Mostrar todos (${total})`;
}

// Linhas de uma tabela de resultados (estados, municípios, cidades ou regiões).
function linhasHtml(tabela, linhas) {
  return linhas.map(({ chave, nome, uf, regiao, r }) => {
    const ok = publicado(r);
    const lider = ok && r.cand.length >= 2 && r.cand[0].votos > r.cand[1].votos ? r.cand[0].n : null;
    // Cada célula compara o texto exibido com o anterior; só o que mudou na tela brilha.
    let maisRecente = null;
    // valor/tipo: o número conta até o novo valor; texto: o que aparece ao final (compara o brilho).
    const td = (id, classe, valor, tipo, extra = '') => {
      const k = `${tabela}|${chave}|${id}`;
      const texto = valor == null ? '–' : FORMATOS[tipo](valor);
      const passou = marca(k, texto);
      if (passou != null && (maisRecente == null || passou < maisRecente)) maisRecente = passou;
      const b = attrsBrilho(passou);
      const conteudo = valor == null ? (contas.delete(k), '–') : numHtml(k, valor, tipo, 'span', extra);
      return `<td class="${classe}${b.cls}"${b.estilo}>${conteudo}</td>`;
    };
    let apur = td('apur', 'pct-apur', r ? r.pst : null, 'pct0');
    // Regiões e estados: barrinha de progresso das seções apuradas dentro da célula.
    if ((tabela === 'regioes' || uf) && r) apur = apur.replace(/<\/td>$/, `<span class="mini-apur" aria-hidden="true"><i style="width:${Math.min(100, r.pst)}%"></i></span></td>`);
    const cels = ORDEM.map((n) => {
      const c = doNumero(r, n);
      return td(n, `v${n}`, ok && c ? c.pct : null, 'pct1', lider === n ? 'lid' : '');
    }).join('');
    const dif = ok && r.cand.length >= 2 ? r.cand[0].votos - r.cand[1].votos : null;
    // A chave da diferença inclui o líder: virada de liderança recomeça do zero.
    const celDif = td('dif' + lider, lider ? 'dif' + lider : 'sem', dif != null && lider ? dif : null, 'comp');
    // A linha inteira ganha uma faixa lateral enquanto alguma célula dela brilha.
    const bl = attrsBrilho(maisRecente, 'linha-mudou');
    return `<tr class="${bl.cls.trim()}"${bl.estilo} data-chave="${chave}"${uf ? ` data-uf="${uf}"` : ''}${regiao ? ` data-regiao="${regiao}"` : ''}><td title="${escapar(nome)}">${escapar(nome)}</td>${apur}${cels}${celDif}</tr>`;
  }).join('');
}

// ---------- leituras ----------
// brPronto: resultado nacional que acabou de ser lido na conferência de 5 s (evita reler).
async function atualizarEstados(brPronto = null) {
  const { ciclo, cd } = est.eleicao;
  est.carregandoUfs = true;
  // Cada estado entra na tela assim que chega (redesenho agrupado a cada 0,4 s): no pico,
  // com o TSE recusando leituras, esperar os 28 deixava tudo vazio por muitos segundos.
  let redesenho = null;
  const redesenhar = () => { if (!redesenho) redesenho = setTimeout(() => { redesenho = null; pintarMapa(); desenharTabela(); desenharExterior(); desenharRegioes(); }, 400); };
  const pedidos = [['br', brPronto ? Promise.resolve(brPronto) : lerResultado(ciclo, cd, 'br')], ...[...UFS, EXT].map((uf) => [uf, lerResultado(ciclo, cd, uf).then((v) => {
    if (v.resultado) { est.ufs[uf] = v; redesenhar(); }
    return v;
  })])];
  const res = await Promise.allSettled(pedidos.map((p) => p[1]));
  // Estados recusados no pico (429) e ainda sem nenhum dado: mais uma tentativa, um por vez.
  for (let i = 1; i < pedidos.length; i++) {
    const uf = pedidos[i][0];
    if (res[i].status === 'fulfilled' && res[i].value.resultado) continue;
    if (est.ufs[uf]) continue; // já há um dado anterior na tela
    await new Promise((r) => setTimeout(r, 300));
    const novo = await lerResultado(ciclo, cd, uf);
    res[i] = { status: 'fulfilled', value: novo };
  }
  res.forEach((s, i) => {
    const chave = pedidos[i][0];
    if (s.status !== 'fulfilled') return;
    // Uma leitura com falha não apaga o último dado bom: o placar não pisca para "–".
    if (s.value.resultado) {
      if (chave === 'br') est.br = s.value; else est.ufs[chave] = s.value;
    }
    if (chave === 'br') est.statusBr = s.value.status;
  });
  est.carregandoUfs = false;
  clearTimeout(redesenho);
  est.ultimaLeitura = est.ultimaConferencia = new Date();
  reiniciarAnel();
  est.ultimoCompleto = Date.now();
  est.assinaturaBr = assinatura(est.br?.resultado);
  const r = est.br?.resultado;
  if (est.statusBr === 404 || (r && !publicado(r))) aviso('');
  else if (!r) aviso(`Não foi possível ler o resultado nacional (situação: ${est.statusBr}). Nova tentativa em 30 s.`, true);
  else aviso('');
  desenharPlacar(); pintarMapa(); desenharTabela(); desenharExterior(); desenharRegioes(); desenharContagem(); atualizarDiag();
}

// Identifica uma versão do arquivo nacional: idg é o identificador de geração do TSE.
const assinatura = (r) => (r ? [r.idg, r.dg, r.hg, r.pst, r.totalCand].join('|') : null);

// Conferência rápida: lê só o arquivo nacional; se mudou (ou passou 1 min), lê tudo.
async function conferirBr() {
  const { ciclo, cd } = est.eleicao;
  $('#aovivo').classList.add('lendo');
  const res = await lerResultado(ciclo, cd, 'br');
  $('#aovivo').classList.remove('lendo');
  est.ultimaConferencia = new Date();
  reiniciarAnel();
  const mudou = res.resultado && assinatura(res.resultado) !== est.assinaturaBr;
  if (mudou || Date.now() - est.ultimoCompleto >= T_COMPLETO) {
    await atualizarEstados(res);
    // Nova divulgação do TSE: os municípios também andaram; relê se a última carga não é recente.
    if (mudou && !carga.ativa && Date.now() - est.ultimaCargaMun >= T_MUN_MIN) cicloMunicipios();
  }
  atualizarIdade();
}

// Fila de municípios com até 6 leituras simultâneas. Uma troca de recorte cancela a carga
// em andamento (geração diferente), para não gastar dados com o que saiu da tela.
const carga = { geracao: 0, ativa: false, timer: null };
async function cicloMunicipios() {
  clearTimeout(carga.timer);
  const geracao = ++carga.geracao;
  // Região na visão de municípios: apenas os municípios dos estados dela.
  const naRegiao = (m) => !est.regiao || REGIOES[est.regiao].ufs.includes(m.uf);
  const alvo = est.uf ? est.munCfg.filter((m) => m.uf === est.uf) : est.nivel === 'municipios' ? est.munCfg.filter((m) => m.uf !== EXT && naRegiao(m)) : [];
  // Antes da divulgação não há o que ler nos municípios; poupa a rede de quem já abriu a página.
  if (!alvo.length || !publicado(est.br?.resultado)) {
    $('#progresso').hidden = true;
    if (alvo.length) carga.timer = setTimeout(cicloMunicipios, T_COMPLETO);
    return;
  }
  carga.ativa = true;
  est.ultimaCargaMun = Date.now();
  let feitos = 0, falhas = 0, ultimaPintura = 0;
  const mostrar = () => {
    $('#progresso').hidden = false;
    // No Brasil inteiro são milhares de arquivos por ciclo: no celular isso pesa na franquia.
    const peso = alvo.length > 1000 ? ' · consome mais dados; escolha um estado para economizar' : '';
    $('#progresso-txt').textContent = `Lendo municípios no TSE: ${fmtInt.format(feitos)} de ${fmtInt.format(alvo.length)}${falhas ? ` (${falhas} sem resposta)` : ''}${peso}`;
    $('#progresso-barra').style.width = (100 * feitos) / alvo.length + '%';
  };
  mostrar();
  let i = 0;
  const trabalhador = async () => {
    while (i < alvo.length && geracao === carga.geracao) {
      const m = alvo[i++];
      const res = await lerResultado(est.eleicao.ciclo, est.eleicao.cd, m.uf, m.cd);
      if (geracao !== carga.geracao) return;
      if (res.resultado) est.mun.set(m.cd, res); else falhas++;
      feitos++;
      // Repinta em lotes: 5.570 repinturas do mapa travariam o celular.
      if (performance.now() - ultimaPintura > 700) { ultimaPintura = performance.now(); mostrar(); pintarMapa(); if (est.uf) desenharTabela(); }
    }
  };
  await Promise.all(Array.from({ length: PARALELO }, trabalhador));
  if (geracao !== carga.geracao) return;
  // Leituras recusadas no pico (429) ou com erro: mais uma tentativa, uma por vez, no fim
  // da rodada, em vez de deixar o local com "–" até a rodada seguinte.
  const faltaram = alvo.filter((m) => !est.mun.get(m.cd)?.resultado);
  for (const m of faltaram) {
    if (geracao !== carga.geracao) return;
    await new Promise((r) => setTimeout(r, 250));
    const res = await lerResultado(est.eleicao.ciclo, est.eleicao.cd, m.uf, m.cd);
    if (res.resultado) { est.mun.set(m.cd, res); falhas--; }
  }
  if (geracao !== carga.geracao) return;
  carga.ativa = false;
  mostrar();
  setTimeout(() => { if (geracao === carga.geracao) $('#progresso').hidden = true; }, 2500);
  pintarMapa(); desenharTabela(); desenharExterior(); atualizarDiag();
  carga.timer = setTimeout(cicloMunicipios, est.uf ? T_MUN_UF : T_MUN_BR);
}

async function carregarConfigMunicipios() {
  const { ciclo, cd } = est.eleicao;
  const { lista, status } = await lerMunicipios(ciclo, cd);
  if (!lista.length) return status;
  est.munCfg = lista;
  est.tsePorIbge.clear(); est.semLigacao = [];
  for (const m of lista) {
    if (m.uf === EXT) continue; // cidades do exterior não estão no mapa
    let ibge = m.cdi && geo.ibges.has(m.cdi) ? m.cdi : null;
    if (!ibge) ibge = geo.porNome.get(normalizarNome(m.nome) + '|' + m.uf) || null;
    if (ibge) est.tsePorIbge.set(ibge, m.cd); else est.semLigacao.push(`${m.nome}/${m.uf.toUpperCase()}`);
  }
  return status;
}

// ---------- descoberta e laços ----------
let timerUf = null;
async function iniciarDados() {
  const forcar = params.get('e');
  const d = await descobrirEleicao('ele2026', forcar);
  est.descoberta = d;
  if (!d.ok) {
    if (d.motivo === 'config') aviso(`A configuração das eleições do TSE ainda não está disponível (situação: ${d.status}). Nova tentativa em 30 s.`);
    else aviso('');
    desenharContagem();
    desenharPlacar(); atualizarDiag();
    // Falha por pico (429) ou rede: tenta logo; sem 2º turno publicado: espera mais.
    setTimeout(iniciarDados, d.testadas?.some((t) => t.status === 429 || t.status === 'erro de rede') ? 5e3 : T_RETENTA);
    return;
  }
  est.eleicao = { ciclo: d.ciclo, cd: d.cd, nm: d.nm };
  est.br = { status: 200, resultado: d.br };
  desenharPlacar();
  await carregarConfigMunicipios();
  await atualizarEstados();
  lacoEstados();
  cicloMunicipios();
}
function lacoEstados() {
  clearTimeout(timerUf);
  timerUf = setTimeout(async () => {
    if (!document.hidden) {
      try { await conferirBr(); } catch (e) { /* uma falha de rede não para o laço */ }
      if (!est.munCfg.length) await carregarConfigMunicipios();
    }
    lacoEstados();
  }, T_BR);
}
// Aba em segundo plano não lê nada (bateria e franquia de dados do celular); ao voltar, lê na hora.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  conferirVersao();
  if (!est.eleicao) return;
  atualizarEstados().then(lacoEstados);
  if (!carga.ativa) cicloMunicipios();
});

// "há 7 s": mostra que o painel está vivo mesmo quando o TSE não publicou nada novo.
// Indicador "ao vivo": ponto pulsando, idade da última conferência e um anel que enche
// até a próxima. Enquanto a leitura está em curso, o ponto pisca rápido ("consultando").
// Faixa discreta sobre a prorrogação. A fase sai do relógio e do horário do próprio
// arquivo do TSE (hg/dg); o aviso de dados parados sai do tempo sem nova versão (idg).
function horaTse(r) {
  const m = r?.dg && r?.hg && r.dg.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  return m ? new Date(`${m[3]}-${m[2]}-${m[1]}T${r.hg}-03:00`).getTime() : null;
}
const hhmm = (t) => new Date(t).toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });
function desenharNota() {
  const el = $('#nota');
  const r = est.br?.resultado;
  if (DEMO || !est.eleicao) { el.hidden = true; return; }
  const agora = Date.now();
  const tTse = horaTse(r);
  const ok = publicado(r);
  let resumo, detalhe;
  if (agora < FECHAMENTO) {
    resumo = 'Votação prorrogada até 19h (STF)';
    if (ok && tTse) resumo += ` · parcial de ${pct(r.pst)} divulgada às ${hhmm(tTse)}`;
    detalhe = 'O ministro Cristiano Zanin, do STF, prorrogou o fim da votação para as 19h de Brasília em todo o país. '
      + (ok ? `O TSE já tinha divulgado ${pct(r.pst)} das seções às ${hhmm(tTse)}, antes da prorrogação. É uma fração mínima da apuração e não indica o resultado; os eleitores ainda estão votando. ` : '')
      + 'O painel continua conferindo o TSE a cada 5 s.';
  } else if (!tTse || tTse < FECHAMENTO) {
    resumo = 'Votação encerrada às 19h · aguardando o TSE retomar a divulgação';
    detalhe = `A votação foi prorrogada pelo STF de 17h para 19h.${ok && tTse ? ` Os números na tela ainda são a parcial de ${pct(r.pst)} divulgada às ${hhmm(tTse)}.` : ''} Assim que o TSE publicar a próxima parcial, o painel atualiza sozinho.`;
  } else {
    // TSE retomou depois das 19h: a faixa sai da tela.
    el.hidden = true;
    return;
  }
  // Dados parados: durante a apuração, a última parcial do TSE tem mais de 10 min
  // (pelo horário gravado no próprio arquivo, não pelo momento em que a página abriu).
  const parado = ok && r.pst < 100 && tTse && agora - tTse > PARADO_MIN * 60e3;
  if (parado && tTse) resumo += ` · sem novos dados do TSE desde ${hhmm(tTse)}`;
  el.hidden = false;
  el.classList.toggle('discreta', agora >= FECHAMENTO && tTse && tTse >= FECHAMENTO);
  const sum = el.querySelector('summary'), p = el.querySelector('p');
  if (sum.textContent !== resumo) sum.textContent = resumo;
  if (p.textContent !== detalhe) p.textContent = detalhe;
}

function atualizarIdade() {
  desenharContagem();
  desenharNota();
  const el = $('#aovivo');
  if (!est.ultimaConferencia || !est.eleicao) return;
  el.hidden = false;
  // 100% das seções: sai o "ao vivo" (ponto pulsando, anel, próxima leitura) e entra o
  // aviso de apuração concluída. O painel continua conferindo, caso o TSE corrija algo.
  const r = est.br?.resultado;
  const concluida = publicado(r) && r.pst >= 100;
  el.classList.toggle('final', concluida);
  if (concluida) {
    const t = horaTse(r);
    $('#aovivo-txt').innerHTML = `<b>Apuração concluída</b> · 100% das seções${t ? ` · dados do TSE das ${hhmm(t)}` : ''}`;
    $('#proxima').textContent = '';
    return;
  }
  const s = Math.max(0, Math.round((Date.now() - est.ultimaConferencia) / 1000));
  const lendo = el.classList.contains('lendo');
  const parado = document.hidden;
  $('#aovivo-txt').innerHTML = lendo ? '<b>Ao vivo</b> · consultando o TSE…' : `<b>Ao vivo</b> · conferido ${s < 2 ? 'agora' : `há ${s} s`}`;
  $('#proxima').textContent = parado ? '' : `próxima em ${Math.max(0, Math.ceil((T_BR - (Date.now() - est.ultimaConferencia)) / 1000))} s`;
}
function reiniciarAnel() {
  const anel = $('#anel');
  anel.style.animation = 'none'; void anel.offsetWidth; anel.style.animation = '';
}
setInterval(atualizarIdade, 1000);

// Troca de versão do site: o HTML fica até 10 min no cache do navegador (regra do GitHub
// Pages). A página confere versao.json e, se saiu versão nova, recarrega com um parâmetro
// novo na URL, que obriga o navegador a buscar o HTML de novo.
async function conferirVersao() {
  if (VERSAO === 'dev' || DEMO) return; // no demo não recarrega: atrapalharia a apresentação
  try {
    const r = await fetch('versao.json?t=' + Date.now(), { cache: 'no-store' });
    const { v } = await r.json();
    if (v && v !== VERSAO) {
      const u = new URL(location.href);
      u.searchParams.set('_v', v);
      location.replace(u.toString());
    }
  } catch { /* sem versao.json (servidor local): segue a vida */ }
}
setInterval(() => { if (!document.hidden) conferirVersao(); }, T_VERSAO);

function escolherRegiao(id) {
  evento('escolheu-regiao', { regiao: REGIOES[id].nome });
  est.regiao = id; est.uf = null;
  fecharPainel();
  aplicarVista();
  if (est.eleicao) cicloMunicipios();
  $('.cartao-mapa').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function escolherUf(uf) {
  if (uf) evento(uf === EXT ? 'abriu-exterior' : 'escolheu-estado', { uf: uf.toUpperCase() });
  // Estado escolhido dentro de uma região: o "voltar" leva de volta à região.
  if (!uf && est.uf && est.regiao && REGIOES[est.regiao].ufs.includes(est.uf)) { est.uf = null; est.limiteTabela = 60; fecharPainel(); aplicarVista(); if (est.eleicao) cicloMunicipios(); return; }
  if (!uf || uf === EXT || !(est.regiao && REGIOES[est.regiao].ufs.includes(uf))) est.regiao = null;
  est.uf = uf || null;
  est.limiteTabela = 60;
  fecharPainel();
  aplicarVista();
  if (est.eleicao) cicloMunicipios();
  if (uf) $('.cartao-mapa').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ---------- diagnóstico ----------
function atualizarDiag() {
  const det = $('#diagnostico');
  if (!det.open) return;
  const d = est.descoberta;
  const eleicoes = d?.testadas?.length
    ? `<table><thead><tr><th>Código</th><th>Nome</th><th>br-c0001</th><th>Candidatos</th></tr></thead><tbody>${d.testadas.map((t) => `<tr><td>${t.cd}${est.eleicao?.cd === t.cd ? ' ✔' : ''}</td><td>${escapar(t.nm || '')}</td><td>${t.status}</td><td>${t.nCand ?? '–'}</td></tr>`).join('')}</tbody></table>`
    : '<p>Nenhuma eleição testada ainda.</p>';
  const contagem = diagnostico.reduce((m, x) => { m[x.status] = (m[x.status] || 0) + 1; return m; }, {});
  $('#diag-conteudo').innerHTML = `<div class="diag">
    <p>Leitura: <b>${modoAtual()}</b> · Eleição: <b>${est.eleicao ? `${est.eleicao.ciclo}/${est.eleicao.cd}` : 'não encontrada'}</b> · Municípios na configuração: <b>${fmtInt.format(est.munCfg.length)}</b>, ligados ao mapa: <b>${fmtInt.format(est.tsePorIbge.size)}</b>${est.semLigacao.length ? ` (sem ligação: ${escapar(est.semLigacao.slice(0, 12).join(', '))}${est.semLigacao.length > 12 ? '…' : ''})` : ''}</p>
    <p>Últimas ${diagnostico.length} leituras por situação: ${Object.entries(contagem).map(([k, v]) => `${k}: ${v}`).join(' · ')}</p>
    <h3>Eleições encontradas (ele2026)</h3>${eleicoes}
    <h3>Leituras recentes</h3><table><thead><tr><th>Hora</th><th>Situação</th><th>Origem</th><th>ms</th><th>Caminho</th></tr></thead><tbody>
    ${diagnostico.slice(0, 60).map((x) => `<tr><td>${horaBrasilia(x.hora)}</td><td>${x.status}</td><td>${x.origem}</td><td>${x.ms}</td><td><code>${escapar(x.caminho)}</code></td></tr>`).join('')}</tbody></table></div>`;
}

// ---------- início ----------
function ligarControles() {
  const sel = $('#uf');
  sel.insertAdjacentHTML('beforeend', `<option value="${EXT}">Exterior</option>`
    + `<optgroup label="Regiões">${Object.entries(REGIOES).map(([id, g]) => `<option value="reg:${id}">${g.nome}</option>`).join('')}</optgroup>`
    + `<optgroup label="Estados">${UFS.slice().sort((a, b) => NOME_UF[a].localeCompare(NOME_UF[b], 'pt-BR')).map((uf) => `<option value="${uf}">${NOME_UF[uf]}</option>`).join('')}</optgroup>`);
  sel.onchange = () => (sel.value.startsWith('reg:') ? escolherRegiao(sel.value.slice(4)) : escolherUf(sel.value));
  $('#tabela-regioes tbody').addEventListener('click', (ev) => {
    const tr = ev.target.closest('tr[data-regiao]');
    if (tr) escolherRegiao(tr.dataset.regiao);
  });
  document.querySelectorAll('.segmentado button').forEach((b) => {
    b.onclick = () => { est.nivel = b.dataset.nivel; evento('nivel', { nivel: est.nivel }); aplicarVista(); if (est.eleicao) cicloMunicipios(); };
  });
  $('#voltar').onclick = () => escolherUf(null);
  $('#exterior-cartao').onclick = () => escolherUf(est.uf === EXT ? null : EXT);
  $('#painel-fechar').onclick = fecharPainel;
  $('#definicao').addEventListener('click', (ev) => {
    if (ev.target.closest('.rever-festa')) festejar($('#definicao').classList.contains('oficial'), true);
  });
  $('#painel').addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-uf]');
    if (b) escolherUf(b.dataset.uf);
  });
  document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') fecharPainel(); });
  $('#tabela tbody').addEventListener('click', (ev) => {
    const tr = ev.target.closest('tr');
    if (!tr) return;
    if (tr.dataset.uf) { escolherUf(tr.dataset.uf); return; }
    if (est.uf === EXT) {
      const m = est.munCfg.find((x) => x.uf === EXT && x.cd === tr.dataset.chave);
      if (m) abrirPainel(fichaHtml(tituloCaixa(m.nome), 'Exterior', est.mun.get(m.cd)?.resultado || null));
      return;
    }
    const f = geo.municipios.features.find((x) => est.tsePorIbge.get(x.properties.ibge) === tr.dataset.chave);
    if (f) abrirPainel(ficha('mun', f));
  });
  $('#mais').onclick = () => { est.limiteTabela = Infinity; desenharTabela(); };
  $('#diagnostico').addEventListener('toggle', atualizarDiag);
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { lerTema(); desenharLegenda(); pintarMapa(); });
}

async function iniciar() {
  iniciarMetricas();
  if (DEMO) { document.body.classList.add('demo'); $('#faixa-demo').hidden = false; }
  lerTema();
  ligarControles();
  desenharPlacar();
  try {
    await carregarGeo();
  } catch (e) {
    aviso('Não foi possível carregar o mapa. Recarregue a página.', true);
    return;
  }
  if (DEMO) {
    const { criarDemo } = await import('./demo.js?v=dev');
    usarDemo(criarDemo(geo.municipios.features));
  }
  iniciarMapa();
  desenharLegenda();
  aplicarVista();
  iniciarDados();
  conferirVersao();
}

iniciar();
