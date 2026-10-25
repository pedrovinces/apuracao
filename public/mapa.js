// Mapa em SVG com d3. Duas camadas: municípios (desenhados só quando pedidos, são 5.567
// caminhos) e estados (preenchidos no nível Estados, contorno nos demais).
/* global d3 */

export function criarMapa(alvo, geo, eventos) {
  const svg = d3.select(alvo).append('svg').attr('class', 'mapa-svg').attr('role', 'img');
  const raiz = svg.append('g');
  const gMun = raiz.append('g').attr('class', 'camada-mun');
  const gUf = raiz.append('g').attr('class', 'camada-uf');
  let vista = { modo: 'estados', uf: null };
  let cores = { mun: () => null, uf: () => null };
  let largura = 0, altura = 0;

  // Zoom por pinça (dois dedos) ou roda do mouse com Ctrl. Um dedo continua rolando a
  // página: no celular, sequestrar o arraste prende o usuário dentro do mapa.
  const zoom = d3.zoom()
    .scaleExtent([1, 14])
    .filter((ev) => (ev.type === 'wheel' ? ev.ctrlKey || ev.metaKey : ev.type.startsWith('touch') ? ev.touches.length > 1 : !ev.button))
    .on('zoom', (ev) => {
      raiz.attr('transform', ev.transform);
      svg.classed('ampliado', ev.transform.k > 1.01);
      eventos.zoom?.(ev.transform.k > 1.01);
    });
  svg.call(zoom).on('dblclick.zoom', null);

  function caixa(f) { return f.properties.uf; }

  function desenhar() {
    largura = alvo.clientWidth || 360;
    const alvoUf = vista.uf ? geo.estados.features.find((f) => f.properties.uf === vista.uf) : null;
    // Brasil é quase quadrado; um estado alongado (MG, BA) pede menos altura.
    const foco = alvoUf || { type: 'FeatureCollection', features: geo.estados.features };
    const [[x0, y0], [x1, y1]] = d3.geoPath(d3.geoMercator().scale(1).translate([0, 0])).bounds(foco);
    const proporcao = Math.min(1.15, Math.max(0.6, (y1 - y0) / (x1 - x0)));
    altura = Math.round(Math.min(largura * proporcao, window.innerHeight * 0.72));
    svg.attr('viewBox', `0 0 ${largura} ${altura}`).attr('width', largura).attr('height', altura);
    const proj = d3.geoMercator().fitExtent([[6, 6], [largura - 6, altura - 6]], foco);
    const caminho = d3.geoPath(proj);

    const mostrarMun = vista.modo === 'municipios' || !!vista.uf;
    const munis = mostrarMun ? geo.municipios.features.filter((f) => !vista.uf || f.properties.uf === vista.uf) : [];
    gMun.selectAll('path').data(munis, (f) => f.properties.ibge)
      .join('path').attr('d', caminho).attr('class', 'mun');
    const ufs = vista.uf ? [alvoUf] : geo.estados.features;
    gUf.selectAll('path').data(ufs, caixa)
      .join('path').attr('d', caminho)
      .attr('class', mostrarMun ? 'uf contorno' : 'uf');
    svg.attr('aria-label', vista.uf ? `Mapa dos municípios de ${vista.uf}` : mostrarMun ? 'Mapa dos municípios do Brasil' : 'Mapa dos estados');
    svg.call(zoom.transform, d3.zoomIdentity);
    pintar();
    ligarEventos();
  }

  function pintar() {
    gMun.selectAll('path').attr('fill', (f) => cores.mun(f));
    gUf.selectAll('path.uf:not(.contorno)').attr('fill', (f) => cores.uf(f));
  }

  function ligarEventos() {
    const mun = vista.modo === 'municipios' || !!vista.uf;
    const sel = mun ? gMun.selectAll('path') : gUf.selectAll('path');
    const tipo = mun ? 'mun' : 'uf';
    gUf.selectAll('path').on('.', null);
    gMun.selectAll('path').on('.', null);
    sel
      .on('pointermove', (ev, f) => { if (ev.pointerType === 'mouse') eventos.passar(tipo, f, ev); })
      .on('pointerleave', (ev) => { if (ev.pointerType === 'mouse') eventos.sair(); })
      .on('click', (ev, f) => eventos.clicar(tipo, f, ev));
  }

  let espera;
  new ResizeObserver(() => {
    if (Math.abs((alvo.clientWidth || 0) - largura) < 2) return;
    clearTimeout(espera); espera = setTimeout(desenhar, 120);
  }).observe(alvo);

  return {
    mostrar(novaVista) { vista = { ...vista, ...novaVista }; desenhar(); },
    colorir(novasCores) { cores = novasCores; pintar(); },
    restaurarZoom() { svg.transition().duration(250).call(zoom.transform, d3.zoomIdentity); },
    get vista() { return vista; },
  };
}
