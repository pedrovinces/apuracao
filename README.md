# Apuração · 2º turno presidencial 2026

Painel estático (HTML + JS puro, módulos ES) que lê os arquivos públicos de divulgação do TSE
(`https://resultados.tse.jus.br/oficial/`) e mostra placar, mapa por estado e município e tabela.
Publicado pelo GitHub Pages a partir da pasta `public/` (workflow em `.github/workflows/pages.yml`).

- `?demo=1`: dados FICTÍCIOS no formato do TSE, apuração de 0 a 100% em 10 minutos (`&p=50` começa em 50%).
- `?uf=SP`: abre direto nos municípios de um estado (`?uf=ZZ`: votos no exterior, por cidade). `?nivel=municipios`: municípios do Brasil inteiro.
- `?e=6258`: força o código da eleição, pulando a descoberta automática.

## Estrutura

| Caminho | Papel |
| --- | --- |
| `public/index.html`, `estilo.css`, `app.js` | Página, estilos (mobile primeiro, claro/escuro) e lógica de atualização |
| `public/tse.js` | Leitura tolerante: proxy `tse/` se existir, senão o TSE direto; diagnóstico de cada leitura |
| `public/parser.js` | Interpretação dos JSON do TSE (campos procurados por nome, números com vírgula) e descoberta da eleição |
| `public/mapa.js` | Mapa SVG com d3 (pinça de dois dedos para ampliar) |
| `public/demo.js` | Gerador de dados fictícios |
| `public/geo/brasil.topo.json` | Malha IBGE simplificada (camadas `municipios` e `estados`) |
| `functions/tse/[[path]].js` | Proxy com cache de borda, só usado se o site for para o Cloudflare Pages |
| `tools/` | Geração da malha, cópia das bibliotecas, servidor local e teste com Playwright |

## Formato do TSE verificado em 25/10/2026

- `comum/config/ele-c.json`: `pl[]` (pleitos) com `c` = ciclo e `e[]` com `cd` e `cdt2` (código do 2º turno).
  Em 2026: presidente 1º turno = 6257, 2º turno = 6258.
- Resultado: `ele2026/{cd}/dados/{uf}/{uf}{mun?}-c0001-e{cd 6 dígitos}-u.json`, com candidatos em
  `carg[].agr[].par[].cand[]` (`n`, `nmu`, `vap`, `pvap`, `e`, `st`), seções em `s` (`pst`),
  eleitorado em `e` (`te`, `a`, `pa`) e votos em `v` (`vv`, `vb`, `pvb`, `tvn`, `ptvn`).
  O formato `dados-simplificados/...-r.json` de 2022 não existe mais; fica como segunda tentativa.
- Municípios: `ele2026/{cd}/config/mun-e{cd6}-cm.json`, `abr[]` (`cd` = UF) e `mu[]` (`cd`, `cdi`, `nm`).
- O TSE responde CORS ecoando a origem, então o navegador lê direto, sem proxy.
- A CDN do TSE ignora parâmetros na URL e guarda cada arquivo por até ~60 s (`cache-control: max-age` ≤ 60).
  O painel confere o arquivo nacional a cada 5 s e, quando ele muda (`idg`), relê UFs e exterior na hora.
- Exterior: UF `zz`, 186 cidades no `mun-...-cm.json` (sem `cdi`), arquivos `dados/zz/zz<cidade>-c0001-...-u.json`.
- Fotos: `ele2026/6258/fotos/br/<sqcand>.jpeg`; recortadas com `tools/recortar-fotos.py` para `public/img`.

## Cache do GitHub Pages

O GitHub Pages manda o navegador guardar os arquivos por 10 min e não permite mudar isso. Na publicação,
o workflow troca `?v=dev` pelo commit em todas as URLs e grava `versao.json`; a página aberta consulta
esse arquivo a cada minuto (e ao voltar para a aba) e se recarrega quando há versão nova.

## Local

```sh
npm install          # só para regenerar malha/vendor ou testar
npm run serve        # http://localhost:8080/?demo=1
npm test             # Playwright em 1280x900 e 390x844
npm run geo          # regenera public/geo/brasil.topo.json
```

## Análise 1º × 2º turno (`/analise`)

Página estática com a comparação seção por seção entre os turnos, as urnas encerradas após as 17h
(prorrogação até 19h) e um simulador de cenários. Os dados em `public/analise/dados/` são gerados
uma vez, a partir de arquivos públicos do TSE, por três scripts:

```sh
# 1. Boletins de urna (dados abertos), apenas Presidente, um JSON por UF e turno
python tools/analise/extrair_bweb.py links.txt compact        # links.txt: URLs bweb_1t_*/bweb_2t_*
# 2. Logs das urnas do 2º turno: votos depois das 17h (todas as seções fechadas após 17:15
#    e amostra aleatória, semente 20261025, das fechadas entre 17:00 e 17:15)
python tools/analise/logs_pos17.py compact logs_t2.json 2500
# 3. Junta tudo e grava resumo, UFs e municípios
python tools/analise/montar.py compact logs_t2.json mun-e006258-cm.json public/analise/dados br-c0001-e006257-u.json
```

- Boletins: `https://dadosabertos.tse.jus.br/dataset/resultados-2026-boletim-de-urna`.
- Logs: `resultados.tse.jus.br/oficial/ele2026/arquivo-urna/3221/dados/<uf>/<mun>/<zona>/<secao>/…-aux.json`
  (pleito 3220 = 1º turno, 3221 = 2º turno). Do log só saem contagens; dados de mesários não são guardados.
- Horários convertidos para Brasília pela hora local de abertura (todas as urnas abrem às 8h de Brasília).
- O voto é secreto: o log mostra quantos votaram em cada horário, nunca em quem.

### Estudos complementares e respostas

```sh
# biometria por seção (2026), dos boletins de cada turno
python tools/analise/extrair_biometria.py links.txt bio 1
python tools/analise/extrair_biometria.py <pasta com bweb_2t_*.zip> bio 2
# 2022 como referência: boletins dos dois turnos (dataset resultados-2022-boletim-de-urna)
python tools/analise/extrair_bweb.py links2022.txt compact2022
# biometria, horário x resultado, seções extremas e teste de vizinhança (2026 e 2022)
python tools/analise/estudos.py compact bio compact2022 public/analise/dados/estudos.json
```

- `public/analise/respostas.html`: as afirmações sobre o 2º turno conferidas com esses dados, em linguagem simples,
  com links para cada número no painel.
- Teste de vizinhança: em cada local de votação com 4+ seções, a variação de Lula (1º→2º turno) de cada seção é
  comparada com a mediana das vizinhas e ajustada (regressão nacional) pelo estoque de votos dos outros candidatos
  no 1º turno e pela variação do comparecimento. Adulteração favorecendo um lado apareceria como excesso de
  desvios para esse lado.
