// Teste de fumaça no Chromium (Playwright já instalado no ambiente): abre o painel em
// desktop e celular, nos modos Estados, Municípios do Brasil e ?uf=SP, e falha se houver
// erro no console ou rolagem horizontal. Uso: node tools/testar.mjs [baseUrl] [pastaScreenshots]
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
// require (e não import) para achar o Playwright global do ambiente, fora de node_modules.
const { chromium } = createRequire(import.meta.url)('playwright');

const base = process.argv[2] || 'http://localhost:8080/';
const pasta = process.argv[3] || 'testes';
mkdirSync(pasta, { recursive: true });
const telas = [{ nome: 'desktop', width: 1280, height: 900 }, { nome: 'celular', width: 390, height: 844, mobile: true }];
const casos = [
  { nome: 'estados', q: '?demo=1&p=45' },
  { nome: 'municipios-br', q: '?demo=1&p=60&nivel=municipios', espera: 'municipios' },
  { nome: 'uf-sp', q: '?demo=1&p=70&uf=SP', espera: 'municipios' },
  { nome: 'final', q: '?demo=1&p=100&uf=BA', espera: 'municipios' },
  { nome: 'exterior', q: '?demo=1&p=80&uf=ZZ', espera: 'municipios' },
];
const extra = process.env.REAL ? [{ nome: 'real', q: '', real: true }] : [];
const navegador = await chromium.launch(process.env.HTTPS_PROXY ? { proxy: { server: process.env.HTTPS_PROXY, bypass: 'localhost,127.0.0.1' } } : {});
let falhou = false;
for (const tela of telas) {
  for (const caso of [...casos, ...extra]) {
    const ctx = await navegador.newContext({ viewport: { width: tela.width, height: tela.height }, isMobile: !!tela.mobile, hasTouch: !!tela.mobile, deviceScaleFactor: tela.mobile ? 2 : 1 });
    const pag = await ctx.newPage();
    const erros = [];
    pag.on('console', (m) => { if (m.type() === 'error' && !(caso.real && /404|Failed to load resource/.test(m.text()))) erros.push(m.text()); });
    pag.on('pageerror', (e) => erros.push(String(e)));
    await pag.goto(base + caso.q, { waitUntil: 'load' });
    await pag.waitForSelector(caso.q.includes('uf=ZZ') ? '#exterior-resumo .ficha-titulo' : '.mapa-svg path', { timeout: 20000 });
    if (caso.espera === 'municipios') {
      // Espera a carga dos municípios terminar ("N de N").
      await pag.waitForFunction(() => /: ([\d.]+) de \1\b/.test(document.querySelector('#progresso-txt')?.textContent || ''), null, { timeout: 240000 }).catch(() => console.log('  (carga de municípios não terminou a tempo)'));
      await pag.waitForTimeout(1500);
    } else await pag.waitForTimeout(caso.real ? 6000 : 2500);
    const info = await pag.evaluate(() => ({
      larguraDoc: document.documentElement.scrollWidth, janela: window.innerWidth,
      placar: [...document.querySelectorAll('.cand-pct')].map((e) => e.textContent).join(' x '),
      apurado: document.querySelector('#apurado-txt').textContent, aviso: document.querySelector('#aviso').hidden ? '' : document.querySelector('#aviso').textContent,
      linhas: document.querySelectorAll('#tabela tbody tr').length, caminhos: document.querySelectorAll('.mapa-svg path').length,
      pintados: [...document.querySelectorAll('.camada-mun path, .camada-uf path:not(.contorno)')].filter((p) => p.getAttribute('fill') && !/rgb\(203|#cbcbcb|#2f3239/.test(p.getAttribute('fill'))).length,
      titulo: document.querySelector('#titulo-mapa').textContent,
    }));
    await pag.screenshot({ path: `${pasta}/${tela.nome}-${caso.nome}.png`, fullPage: true });
    // Toque/clique num estado: deve abrir os municípios dele (e o painel, no celular).
    if (caso.nome === 'estados') {
      const estado = pag.locator('.camada-uf path').nth(5);
      if (tela.mobile) await estado.tap({ force: true }); else await estado.click({ force: true });
      await pag.waitForTimeout(2500);
      const t = await pag.evaluate(() => ({ titulo: document.querySelector('#titulo-mapa').textContent, painel: !document.querySelector('#painel').hidden, url: location.search }));
      console.log('  toque no estado:', JSON.stringify(t));
      await pag.screenshot({ path: `${pasta}/${tela.nome}-toque-estado.png` });
    }
    const rolagem = info.larguraDoc > info.janela;
    if (erros.length || rolagem) falhou = true;
    console.log(`${tela.nome.padEnd(8)} ${caso.nome.padEnd(14)} ${erros.length ? 'ERROS: ' + erros.join(' | ') : 'sem erros'}${rolagem ? ' ROLAGEM HORIZONTAL' : ''}`, JSON.stringify(info));
    await ctx.close();
  }
}
await navegador.close();
process.exit(falhou ? 1 : 0);
