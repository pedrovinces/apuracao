// Copia as bibliotecas de node_modules para public/vendor: em produção nada vem de CDN.
import { copyFileSync, mkdirSync } from 'node:fs';
mkdirSync('public/vendor', { recursive: true });
copyFileSync('node_modules/d3/dist/d3.min.js', 'public/vendor/d3.min.js');
copyFileSync('node_modules/topojson-client/dist/topojson-client.min.js', 'public/vendor/topojson-client.min.js');
console.log('vendor copiado');
