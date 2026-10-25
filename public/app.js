// Painel de apuração do 2º turno presidencial de 2026.
// Fluxo: descobre a eleição no ele-c.json, lê BR + 27 UFs a cada 30 s e, sob demanda,
// os municípios (UF escolhida a cada 60 s; Brasil inteiro a cada 180 s).
/* global d3, topojson */
import { diagnostico, usarDemo, modoAtual } from './tse.js';
import { descobrirEleicao, lerResultado, lerMunicipios, publicado, normalizarNome } from './parser.js';
import { criarMapa } from './mapa.js';

const UFS = ['ac', 'al', 'am', 'ap', 'ba', 'ce', 'df', 'es', 'go', 'ma', 'mg', 'ms', 'mt', 'pa', 'pb', 'pe', 'pi', 'pr', 'rj', 'rn', 'ro', 'rr', 'rs', 'sc', 'se', 'sp', 'to'];
const NOME_UF = {
  ac: 'Acre', al: 'Alagoas', am: 'Amazonas', ap: 'Amapá', ba: 'Bahia', ce: 'Ceará', df: 'Distrito Federal', es: 'Espírito Santo',
  go: 'Goiás', ma: 'Maranhão', mg: 'Minas Gerais', ms: 'Mato Grosso do Sul', mt: 'Mato Grosso', pa: 'Pará', pb: 'Paraíba',
  pe: 'Pernambuco', pi: 'Piauí', pr: 'Paraná', rj: 'Rio de Janeiro', rn: 'Rio Grande do Norte', ro: 'Rondônia', rr: 'Roraima',
  rs: 'Rio Grande do Sul', sc: 'Santa Catarina', se: 'Sergipe', sp: 'São Paulo', to: 'Tocantins',
};
// A cor segue o número do candidato, nunca a posição na lista: se a liderança mudar,
// o vermelho continua sendo do 13 e o azul do 22.
const CAND = {
  13: { nome: 'Lula', partido: 'PT', cor: '#c81e1e' },
  22: { nome: 'Flávio Bolsonaro', partido: 'PL', cor: '#1d4ed8' },
};
const ORDEM = ['13', '22'];
const SATURA = 40; // pontos percentuais de margem em que a cor chega ao máximo
const MINIMO = 0.18; // intensidade mínima: vantagens pequenas também aparecem
const T_UF = 30e3, T_MUN_UF = 60e3, T_MUN_BR = 180e3, T_RETENTA = 30e3, PARALELO = 6;
const MSG_ANTES = 'O TSE ainda não publicou o resultado; a divulgação começa após o fechamento das urnas (17h de Brasília).';

const params = new URLSearchParams(location.search);
const DEMO = params.get('demo') === '1';
const $ = (s) => document.querySelector(s);

const est = {
  eleicao: null, descoberta: null, br: null, ufs: {}, mun: new Map(),
  munCfg: [], tsePorIbge: new Map(), semLigacao: [],
  nivel: params.get('nivel') === 'municipios' ? 'municipios' : 'estados',
  uf: UFS.includes((params.get('uf') || '').toLowerCase()) ? params.get('uf').toLowerCase() : null,
  ultimaLeitura: null, statusBr: null, limiteTabela: 60,
};

// ---------- formatação ----------
const fmtInt = new Intl.NumberFormat('pt-BR');
const fmtCompacto = new Intl.NumberFormat('pt-BR', { notation: 'compact', maximumFractionDigits: 1 });
const pct = (v, casas = 2) => (v == null ? '–' : v.toLocaleString('pt-BR', { minimumFractionDigits: casas, maximumFractionDigits: casas }) + '%');
const horaBrasilia = (d) => d.toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour12: false });
const nomeCand = (c) => CAND[c.n]?.nome || tituloCaixa(c.nome);
const tituloCaixa = (s) => String(s).toLowerCase().replace(/(^|\s)\S/g, (m) => m.toUpperCase());
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
  const r = await fetch('geo/brasil.topo.json');
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
  mapa.mostrar({ modo: est.nivel, uf: est.uf ? est.uf.toUpperCase() : null });
  $('#voltar').hidden = !est.uf;
  $('#titulo-mapa').textContent = est.uf ? NOME_UF[est.uf] : munis ? 'Brasil por município' : 'Brasil por estado';
  $('#dica-uso').textContent = est.uf
    ? 'Toque num município para ver os números. Use dois dedos para ampliar.'
    : munis ? 'Toque num município para ver os números. Use dois dedos para ampliar.' : 'Toque num estado para ver os municípios. Use dois dedos para ampliar.';
  document.querySelectorAll('.segmentado button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.nivel === est.nivel)));
  $('#uf').value = est.uf || '';
  // O endereço reflete a escolha, para compartilhar o link já no recorte certo.
  const p = new URLSearchParams(location.search);
  est.uf ? p.set('uf', est.uf.toUpperCase()) : p.delete('uf');
  est.nivel === 'municipios' ? p.set('nivel', 'municipios') : p.delete('nivel');
  history.replaceState(null, '', location.pathname + (p.toString() ? '?' + p : '') + location.hash);
  pintarMapa();
  desenharTabela();
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
  return `<div class="ficha-titulo">${escapar(titulo)}</div><div class="ficha-sub">${escapar(sub)}${r ? ' · ' + pct(r.pst) + ' das seções apuradas' : ''}</div>${linhasCand(r)}${acao}`;
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

// ---------- placar ----------
function desenharPlacar() {
  const r = est.br?.resultado || null;
  const ok = publicado(r);
  for (const n of ORDEM) {
    const el = document.querySelector(`.cand[data-n="${n}"]`);
    const c = doNumero(r, n);
    el.querySelector('.cand-pct').textContent = ok && c ? pct(c.pct) : '–';
    el.querySelector('.cand-votos').innerHTML = ok && c ? `${fmtInt.format(c.votos)} votos${c.eleito ? ' <span class="selo">ELEITO</span>' : ''}` : '&nbsp;';
  }
  const c13 = doNumero(r, '13'), c22 = doNumero(r, '22');
  $('#barra-disputa .b13').style.width = ok && c13 ? c13.pct + '%' : '0';
  $('#barra-disputa .b22').style.width = ok && c22 ? c22.pct + '%' : '0';
  $('#apurado-txt').innerHTML = `Seções apuradas: <b>${r ? pct(r.pst) : '–'}</b>`;
  $('#apurado-barra').style.width = (r?.pst || 0) + '%';
  if (ok && r.cand.length >= 2) {
    const [a, b] = r.cand;
    const dif = a.votos - b.votos;
    $('#diferenca-txt').innerHTML = dif > 0 ? `<b style="color:var(--t${a.n})">${nomeCand(a)}</b> +${fmtInt.format(dif)}` : 'Empate';
  } else $('#diferenca-txt').textContent = '';

  // A diferença já aparece no placar fixo; aqui ficam os números de apoio, compactos.
  const itens = [];
  if (ok && r.abstencao != null) itens.push(['Abstenção', `${pct(r.pAbstencao, 1)} <small>${fmtCompacto.format(r.abstencao)}</small>`]);
  if (ok && r.brancos != null) itens.push(['Brancos', `${pct(r.pBrancos, 1)} <small>${fmtCompacto.format(r.brancos)}</small>`]);
  if (ok && r.nulos != null) itens.push(['Nulos', `${pct(r.pNulos, 1)} <small>${fmtCompacto.format(r.nulos)}</small>`]);
  const horas = [];
  if (r?.dg) horas.push(`TSE: <b>${escapar(r.hg || '')}</b> de ${escapar(r.dg)}`);
  if (est.ultimaLeitura) horas.push(`última leitura: <b>${horaBrasilia(est.ultimaLeitura)}</b>`);
  $('#horarios').innerHTML = horas.join(' · ');
  $('#numeros').innerHTML = itens.map(([t, v]) => `<div><dt>${t}</dt><dd>${v}</dd></div>`).join('');

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
  thead.innerHTML = `<tr><th class="col-local">${est.uf ? 'Município' : 'Estado'}</th><th class="col-apur">Apur.</th>${ORDEM.map((n) => `<th class="col-c">${CAND[n].nome.split(' ')[0]}</th>`).join('')}<th class="col-dif">Dif.</th></tr>`;
  let linhas;
  if (est.uf) {
    $('#titulo-tabela').textContent = `Municípios de ${NOME_UF[est.uf]}`;
    linhas = est.munCfg.filter((m) => m.uf === est.uf).map((m) => ({ chave: m.cd, nome: tituloCaixa(m.nome), r: est.mun.get(m.cd)?.resultado || null }));
  } else {
    $('#titulo-tabela').textContent = 'Por estado';
    linhas = UFS.map((uf) => ({ chave: uf, nome: NOME_UF[uf], uf, r: resultadoUf(uf) }));
  }
  linhas.sort((a, b) => (b.r?.totalCand || 0) - (a.r?.totalCand || 0) || a.nome.localeCompare(b.nome, 'pt-BR'));
  const total = linhas.length;
  if (est.uf) linhas = linhas.slice(0, est.limiteTabela);
  tbody.innerHTML = linhas.map(({ chave, nome, uf, r }) => {
    const ok = publicado(r);
    const lider = ok && r.cand.length >= 2 && r.cand[0].votos > r.cand[1].votos ? r.cand[0].n : null;
    const cels = ORDEM.map((n) => {
      const c = doNumero(r, n);
      return `<td class="v${n}">${ok && c ? (lider === n ? `<span class="lid">${pct(c.pct, 1)}</span>` : pct(c.pct, 1)) : '–'}</td>`;
    }).join('');
    const dif = ok && r.cand.length >= 2 ? r.cand[0].votos - r.cand[1].votos : null;
    return `<tr data-chave="${chave}"${uf ? ` data-uf="${uf}"` : ''}><td title="${escapar(nome)}">${escapar(nome)}</td><td class="pct-apur">${r ? pct(r.pst, 0) : '–'}</td>${cels}<td class="${lider ? 'dif' + lider : 'sem'}">${dif != null && lider ? fmtCompacto.format(dif) : '–'}</td></tr>`;
  }).join('');
  $('#mais').hidden = !est.uf || total <= est.limiteTabela;
  $('#mais').textContent = `Mostrar todos (${total})`;
}

// ---------- leituras ----------
async function atualizarEstados() {
  const { ciclo, cd } = est.eleicao;
  const pedidos = [['br', lerResultado(ciclo, cd, 'br')], ...UFS.map((uf) => [uf, lerResultado(ciclo, cd, uf)])];
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
  est.ultimaLeitura = new Date();
  const r = est.br?.resultado;
  if (est.statusBr === 404 || (r && !publicado(r))) aviso(MSG_ANTES);
  else if (!r) aviso(`Não foi possível ler o resultado nacional (situação: ${est.statusBr}). Nova tentativa em 30 s.`, true);
  else aviso('');
  desenharPlacar(); pintarMapa(); desenharTabela(); atualizarDiag();
}

// Fila de municípios com até 6 leituras simultâneas. Uma troca de recorte cancela a carga
// em andamento (geração diferente), para não gastar dados com o que saiu da tela.
const carga = { geracao: 0, ativa: false, timer: null };
async function cicloMunicipios() {
  clearTimeout(carga.timer);
  const geracao = ++carga.geracao;
  const alvo = est.uf ? est.munCfg.filter((m) => m.uf === est.uf) : est.nivel === 'municipios' ? est.munCfg : [];
  // Antes da divulgação não há o que ler nos municípios; poupa a rede de quem já abriu a página.
  if (!alvo.length || !publicado(est.br?.resultado)) {
    $('#progresso').hidden = true;
    if (alvo.length) carga.timer = setTimeout(cicloMunicipios, T_UF);
    return;
  }
  carga.ativa = true;
  let feitos = 0, falhas = 0, ultimaPintura = 0;
  const mostrar = () => {
    $('#progresso').hidden = false;
    $('#progresso-txt').textContent = `Lendo municípios no TSE: ${fmtInt.format(feitos)} de ${fmtInt.format(alvo.length)}${falhas ? ` (${falhas} sem resposta)` : ''}`;
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
  pintarMapa(); desenharTabela(); atualizarDiag();
  carga.timer = setTimeout(cicloMunicipios, est.uf ? T_MUN_UF : T_MUN_BR);
}

async function carregarConfigMunicipios() {
  const { ciclo, cd } = est.eleicao;
  const { lista, status } = await lerMunicipios(ciclo, cd);
  if (!lista.length) return status;
  est.munCfg = lista;
  est.tsePorIbge.clear(); est.semLigacao = [];
  for (const m of lista) {
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
      await atualizarEstados();
      if (!est.munCfg.length) await carregarConfigMunicipios();
    }
    lacoEstados();
  }, T_UF);
}
// Aba em segundo plano não lê nada (bateria e franquia de dados do celular); ao voltar, lê na hora.
document.addEventListener('visibilitychange', () => {
  if (document.hidden || !est.eleicao) return;
  atualizarEstados().then(lacoEstados);
  if (!carga.ativa) cicloMunicipios();
});

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
  sel.insertAdjacentHTML('beforeend', UFS.slice().sort((a, b) => NOME_UF[a].localeCompare(NOME_UF[b], 'pt-BR')).map((uf) => `<option value="${uf}">${NOME_UF[uf]}</option>`).join(''));
  sel.onchange = () => escolherUf(sel.value);
  document.querySelectorAll('.segmentado button').forEach((b) => {
    b.onclick = () => { est.nivel = b.dataset.nivel; aplicarVista(); if (est.eleicao) cicloMunicipios(); };
  });
  $('#voltar').onclick = () => escolherUf(null);
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
    const { criarDemo } = await import('./demo.js');
    usarDemo(criarDemo(geo.municipios.features));
  }
  iniciarMapa();
  desenharLegenda();
  aplicarVista();
  iniciarDados();
}

iniciar();
