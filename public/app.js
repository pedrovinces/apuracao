// Painel de apuração do 2º turno presidencial de 2026.
// Fluxo: descobre a eleição no ele-c.json, lê BR + 27 UFs a cada 30 s e, sob demanda,
// os municípios (UF escolhida a cada 60 s; Brasil inteiro a cada 180 s).
/* global d3, topojson */
// O sufixo ?v=dev vira o código do commit na publicação (workflow): cada versão nova tem
// URLs novas e escapa do cache de 10 min que o GitHub Pages impõe.
import { diagnostico, usarDemo, modoAtual } from './tse.js?v=dev';
import { descobrirEleicao, lerResultado, lerMunicipios, publicado, normalizarNome } from './parser.js?v=dev';
import { criarMapa } from './mapa.js?v=dev';

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
// nacional (pequeno) é conferido a cada 10 s e, quando muda, as UFs são lidas na hora.
const T_BR = 10e3, T_COMPLETO = 60e3, T_MUN_UF = 60e3, T_MUN_BR = 180e3, T_MUN_MIN = 30e3;
const T_RETENTA = 30e3, T_VERSAO = 60e3, PARALELO = 6;
const MSG_ANTES = 'O TSE ainda não publicou o resultado; a divulgação começa após o fechamento das urnas (17h de Brasília).';

const params = new URLSearchParams(location.search);
const DEMO = params.get('demo') === '1';
const $ = (s) => document.querySelector(s);

const est = {
  eleicao: null, descoberta: null, br: null, ufs: {}, mun: new Map(),
  munCfg: [], tsePorIbge: new Map(), semLigacao: [],
  nivel: params.get('nivel') === 'municipios' ? 'municipios' : 'estados',
  uf: [...UFS, EXT].includes((params.get('uf') || '').toLowerCase()) ? params.get('uf').toLowerCase() : null,
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
  else mapa.mostrar({ modo: est.nivel, uf: est.uf ? est.uf.toUpperCase() : null });
  $('#voltar').hidden = !est.uf;
  $('#titulo-mapa').textContent = exterior ? 'Votos no exterior' : est.uf ? NOME_UF[est.uf] : munis ? 'Brasil por município' : 'Brasil por estado';
  $('#dica-uso').textContent = est.uf
    ? 'Toque num município para ver os números. Use dois dedos para ampliar.'
    : munis ? 'Toque num município para ver os números. Use dois dedos para ampliar.' : 'Toque num estado para ver os municípios. Use dois dedos para ampliar.';
  document.querySelectorAll('.segmentado button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.nivel === est.nivel)));
  $('#uf').value = est.uf || '';
  // O endereço reflete a escolha, para compartilhar o link já no recorte certo.
  const p = new URLSearchParams(location.search);
  est.uf ? p.set('uf', est.uf.toUpperCase()) : p.delete('uf');
  est.nivel === 'municipios' ? p.set('nivel', 'municipios') : p.delete('nivel');
  p.delete('_v'); // marca usada só para furar o cache do HTML na troca de versão
  history.replaceState(null, '', location.pathname + (p.toString() ? '?' + p : '') + location.hash);
  pintarMapa();
  desenharTabela();
  desenharExterior();
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
  return fichaHtml(titulo, sub, r, acao);
}
function fichaHtml(titulo, sub, r, acao = '') {
  return `<div class="ficha-titulo">${escapar(titulo)}</div><div class="ficha-sub">${escapar(sub)}${r ? ' · ' + pct(r.pst) + ' das seções apuradas' : ''}</div>${linhasCand(r)}${acao}`;
}

// Cartão do exterior abaixo do placar e resumo no lugar do mapa quando ele é escolhido.
function desenharExterior() {
  const r = resultadoUf(EXT);
  const ok = publicado(r);
  const partes = ok ? ORDEM.map((n) => { const c = doNumero(r, n); return c ? `<b style="color:var(--t${n})">${CAND[n].nome.split(' ')[0]} ${pct(c.pct, 1)}</b>` : ''; }).join(' · ') : 'aguardando o TSE';
  const b = attrsBrilho(ok ? marca('ext|cartao', partes + pct(r.pst, 0)) : null);
  $('#exterior-cartao').innerHTML = `<span class="ext-rotulo">Votos no exterior</span><span class="ext-numeros${b.cls}"${b.estilo}>${partes}${r ? ` <small>· ${pct(r.pst, 0)} apurado</small>` : ''}</span><span class="ext-seta" aria-hidden="true">›</span>`;
  $('#exterior-cartao').setAttribute('aria-pressed', String(est.uf === EXT));
  if (est.uf === EXT) {
    const cidades = est.munCfg.filter((m) => m.uf === EXT).length;
    $('#exterior-resumo').innerHTML = fichaHtml('Brasileiros que votam fora do país', `${cidades ? fmtInt.format(cidades) + ' cidades · ' : ''}${r?.eleitores ? fmtInt.format(r.eleitores) + ' eleitores' : ''}`, r)
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
// Votos do placar sobem contando até o valor novo, como um painel de apuração.
function contar(el, para) {
  const de = Number(el.dataset.valor || para);
  el.dataset.valor = para;
  if (de === para || reduzMovimento.matches) { el.textContent = fmtInt.format(para); return; }
  const t0 = performance.now(), dur = 900;
  const passo = (t) => {
    if (el.dataset.valor !== String(para)) return; // chegou valor mais novo
    const k = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - k, 3);
    el.textContent = fmtInt.format(Math.round(de + (para - de) * e));
    if (k < 1) requestAnimationFrame(passo);
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
    alvo.textContent = ok && c ? pct(c.pct) : '0,00%';
    alvo.classList.toggle('vazio', !(ok && c));
    if (ok && c) brilhar(alvo, 'placar|pct|' + n, alvo.textContent);
    // Com o resultado definido, a foto de quem não foi eleito esmaece.
    el.querySelector('.cand-foto').classList.toggle('perdeu', !!(ok && r.cand.some((x) => x.eleito) && c && !c.eleito));
    const votos = el.querySelector('.cand-votos');
    if (ok && c) {
      if (!votos.querySelector('.n')) votos.innerHTML = '<span class="n"></span> votos<span class="selo-lugar"></span>';
      contar(votos.querySelector('.n'), c.votos);
      votos.querySelector('.selo-lugar').innerHTML = c.eleito ? ' <span class="selo">ELEITO</span>' : '';
    } else votos.innerHTML = '&nbsp;';
  }
  const c13 = doNumero(r, '13'), c22 = doNumero(r, '22');
  $('#barra-disputa .b13').style.width = ok && c13 ? c13.pct + '%' : '0';
  $('#barra-disputa .b22').style.width = ok && c22 ? c22.pct + '%' : '0';
  $('#apurado-txt').innerHTML = `Seções apuradas: <b>${r ? pct(r.pst) : '–'}</b>`;
  if (r) brilhar($('#apurado-txt b'), 'placar|pst', pct(r.pst));
  $('#apurado-barra').style.width = (r?.pst || 0) + '%';
  if (ok && r.cand.length >= 2) {
    const [a, b] = r.cand;
    const dif = a.votos - b.votos;
    $('#diferenca-txt').innerHTML = dif > 0 ? `<b style="color:var(--t${a.n})">${nomeCand(a)}</b> <span class="n">+${fmtInt.format(dif)}</span>` : 'Empate';
    const n = $('#diferenca-txt .n');
    if (n) { const passou = marca('placar|dif', n.textContent); if (passou != null) { n.className = 'n mudou'; if (passou > 0) n.style.animationDelay = `-${Math.round(passou)}ms`; } }
  } else $('#diferenca-txt').textContent = '';

  // A diferença já aparece no placar fixo; aqui ficam os números de apoio, compactos.
  const itens = [];
  if (ok && r.abstencao != null) itens.push(['Abstenção', `${pct(r.pAbstencao, 1)} <small>${fmtCompacto.format(r.abstencao)}</small>`]);
  if (ok && r.brancos != null) itens.push(['Brancos', `${pct(r.pBrancos, 1)} <small>${fmtCompacto.format(r.brancos)}</small>`]);
  if (ok && r.nulos != null) itens.push(['Nulos', `${pct(r.pNulos, 1)} <small>${fmtCompacto.format(r.nulos)}</small>`]);
  const horas = [];
  if (r?.dg) horas.push(`TSE: <b>${escapar(r.hg || '')}</b> de ${escapar(r.dg)}`);
  if (est.ultimaConferencia) horas.push(`conferido <b id="idade">agora</b> (a cada 10 s)`);
  $('#horarios').innerHTML = horas.join(' · ');
  $('#numeros').innerHTML = itens.map(([t, v]) => {
    const b = attrsBrilho(marca('num|' + t, v));
    return `<div class="${b.cls.trim()}"${b.estilo}><dt>${t}</dt><dd>${v}</dd></div>`;
  }).join('');

  const pil = $('#estado-ao-vivo');
  pil.className = 'pilula';
  if (!est.eleicao) pil.textContent = 'procurando eleição';
  else if (!ok) pil.textContent = 'aguardando o TSE';
  else if (r.pst >= 100 || r.totalizada) { pil.textContent = 'totalizado'; pil.classList.add('final'); }
  else { pil.textContent = 'ao vivo'; pil.classList.add('vivo'); }
}

function aviso(msg, erro = false) {
  const a = $('#aviso');
  a.hidden = !msg; a.textContent = msg || ''; a.classList.toggle('erro', erro);
}

// ---------- tabela ----------
function desenharTabela() {
  const thead = $('#tabela thead'), tbody = $('#tabela tbody');
  thead.innerHTML = `<tr><th class="col-local">${est.uf === EXT ? 'Cidade' : est.uf ? 'Município' : 'Estado'}</th><th class="col-apur">Apur.</th>${ORDEM.map((n) => `<th class="col-c">${CAND[n].nome.split(' ')[0]}</th>`).join('')}<th class="col-dif">Dif.</th></tr>`;
  let linhas;
  if (est.uf) {
    $('#titulo-tabela').textContent = est.uf === EXT ? 'Cidades no exterior' : `Municípios ${DO_UF[est.uf]} ${NOME_UF[est.uf]}`;
    linhas = est.munCfg.filter((m) => m.uf === est.uf).map((m) => ({ chave: m.cd, nome: tituloCaixa(m.nome), r: est.mun.get(m.cd)?.resultado || null }));
  } else {
    $('#titulo-tabela').textContent = 'Por estado';
    linhas = [...UFS, EXT].map((uf) => ({ chave: uf, nome: NOME_UF[uf], uf, r: resultadoUf(uf) }));
  }
  linhas.sort((a, b) => (b.r?.totalCand || 0) - (a.r?.totalCand || 0) || a.nome.localeCompare(b.nome, 'pt-BR'));
  const total = linhas.length;
  if (est.uf) linhas = linhas.slice(0, est.limiteTabela);
  const tabela = est.uf || 'br';
  tbody.innerHTML = linhas.map(({ chave, nome, uf, r }) => {
    const ok = publicado(r);
    const lider = ok && r.cand.length >= 2 && r.cand[0].votos > r.cand[1].votos ? r.cand[0].n : null;
    // Cada célula compara o texto exibido com o anterior; só o que mudou na tela brilha.
    let maisRecente = null;
    const td = (id, classe, texto, html = texto) => {
      const passou = marca(`${tabela}|${chave}|${id}`, texto);
      if (passou != null && (maisRecente == null || passou < maisRecente)) maisRecente = passou;
      const b = attrsBrilho(passou);
      return `<td class="${classe}${b.cls}"${b.estilo}>${html}</td>`;
    };
    const apur = td('apur', 'pct-apur', r ? pct(r.pst, 0) : '–');
    const cels = ORDEM.map((n) => {
      const c = doNumero(r, n);
      const texto = ok && c ? pct(c.pct, 1) : '–';
      return td(n, `v${n}`, texto, lider === n ? `<span class="lid">${texto}</span>` : texto);
    }).join('');
    const dif = ok && r.cand.length >= 2 ? r.cand[0].votos - r.cand[1].votos : null;
    const celDif = td('dif', lider ? 'dif' + lider : 'sem', dif != null && lider ? fmtCompacto.format(dif) : '–');
    // A linha inteira ganha uma faixa lateral enquanto alguma célula dela brilha.
    const bl = attrsBrilho(maisRecente, 'linha-mudou');
    return `<tr class="${bl.cls.trim()}"${bl.estilo} data-chave="${chave}"${uf ? ` data-uf="${uf}"` : ''}><td title="${escapar(nome)}">${escapar(nome)}</td>${apur}${cels}${celDif}</tr>`;
  }).join('');
  $('#mais').hidden = !est.uf || total <= est.limiteTabela;
  $('#mais').textContent = `Mostrar todos (${total})`;
}

// ---------- leituras ----------
// brPronto: resultado nacional que acabou de ser lido na conferência de 10 s (evita reler).
async function atualizarEstados(brPronto = null) {
  const { ciclo, cd } = est.eleicao;
  const pedidos = [['br', brPronto ? Promise.resolve(brPronto) : lerResultado(ciclo, cd, 'br')], ...[...UFS, EXT].map((uf) => [uf, lerResultado(ciclo, cd, uf)])];
  const res = await Promise.allSettled(pedidos.map((p) => p[1]));
  res.forEach((s, i) => {
    const chave = pedidos[i][0];
    if (s.status !== 'fulfilled') return;
    // Uma leitura com falha não apaga o último dado bom: o placar não pisca para "–".
    if (s.value.resultado) {
      if (chave === 'br') est.br = s.value; else est.ufs[chave] = s.value;
    }
    if (chave === 'br') est.statusBr = s.value.status;
  });
  est.ultimaLeitura = est.ultimaConferencia = new Date();
  est.ultimoCompleto = Date.now();
  est.assinaturaBr = assinatura(est.br?.resultado);
  const r = est.br?.resultado;
  if (est.statusBr === 404 || (r && !publicado(r))) aviso(MSG_ANTES);
  else if (!r) aviso(`Não foi possível ler o resultado nacional (situação: ${est.statusBr}). Nova tentativa em 30 s.`, true);
  else aviso('');
  desenharPlacar(); pintarMapa(); desenharTabela(); desenharExterior(); atualizarDiag();
}

// Identifica uma versão do arquivo nacional: idg é o identificador de geração do TSE.
const assinatura = (r) => (r ? [r.idg, r.dg, r.hg, r.pst, r.totalCand].join('|') : null);

// Conferência rápida: lê só o arquivo nacional; se mudou (ou passou 1 min), lê tudo.
async function conferirBr() {
  const { ciclo, cd } = est.eleicao;
  const res = await lerResultado(ciclo, cd, 'br');
  est.ultimaConferencia = new Date();
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
  const alvo = est.uf ? est.munCfg.filter((m) => m.uf === est.uf) : est.nivel === 'municipios' ? est.munCfg.filter((m) => m.uf !== EXT) : [];
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
    else aviso(MSG_ANTES + ' Nova tentativa em 30 s.');
    desenharPlacar(); atualizarDiag();
    setTimeout(iniciarDados, T_RETENTA);
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
function atualizarIdade() {
  const el = $('#idade');
  if (!el || !est.ultimaConferencia) return;
  const s = Math.max(0, Math.round((Date.now() - est.ultimaConferencia) / 1000));
  el.textContent = s < 2 ? 'agora' : `há ${s} s`;
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

function escolherUf(uf) {
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
  sel.insertAdjacentHTML('beforeend', `<option value="${EXT}">Exterior</option>`);
  sel.insertAdjacentHTML('beforeend', UFS.slice().sort((a, b) => NOME_UF[a].localeCompare(NOME_UF[b], 'pt-BR')).map((uf) => `<option value="${uf}">${NOME_UF[uf]}</option>`).join(''));
  sel.onchange = () => escolherUf(sel.value);
  document.querySelectorAll('.segmentado button').forEach((b) => {
    b.onclick = () => { est.nivel = b.dataset.nivel; aplicarVista(); if (est.eleicao) cicloMunicipios(); };
  });
  $('#voltar').onclick = () => escolherUf(null);
  $('#exterior-cartao').onclick = () => escolherUf(est.uf === EXT ? null : EXT);
  $('#painel-fechar').onclick = fecharPainel;
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
