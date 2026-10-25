// Gera public/geo/brasil.topo.json a partir do pacote ibge-cidades-com-poligonos.
// Rodar uma vez (npm run geo); o resultado é versionado para o site não ter etapa de build.
import { readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const origem = 'node_modules/ibge-cidades-com-poligonos/municipios-poligonos.json';
const destino = 'public/geo/brasil.topo.json';
const temp = join(tmpdir(), 'municipios.geojson');

const lista = JSON.parse(readFileSync(origem, 'utf8'));
const geo = {
  type: 'FeatureCollection',
  features: lista.map((m) => ({
    type: 'Feature',
    properties: { ibge: String(m.municipioCodigo), nome: m.municipioNome, uf: m.ufSigla },
    geometry: m.poligono,
  })),
};
writeFileSync(temp, JSON.stringify(geo));
console.log('municípios lidos:', geo.features.length);

// Sem -clean: ele descarta polígonos pequenos ou sobrepostos, e perderíamos municípios.
// keep-shapes impede que um município minúsculo vire geometria vazia na simplificação.
mkdirSync('public/geo', { recursive: true });
execFileSync('node_modules/.bin/mapshaper', [
  '-i', temp, 'name=municipios',
  '-simplify', '6%', 'keep-shapes',
  '-dissolve2', 'uf', '+', 'name=estados',
  '-o', destino, 'format=topojson', 'quantization=10000', 'target=*',
], { stdio: 'inherit' });

const bytes = readFileSync(destino);
const topo = JSON.parse(bytes);
console.log('camadas:', Object.keys(topo.objects).map((k) => `${k}=${topo.objects[k].geometries.length}`).join(' '));
console.log('tamanho:', (statSync(destino).size / 1e6).toFixed(2), 'MB; gzip:', (gzipSync(bytes).length / 1e3).toFixed(0), 'KB');
