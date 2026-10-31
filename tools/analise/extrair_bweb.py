# Extrai dos boletins de urna (dados abertos do TSE, arquivos bweb_<turno>t_<UF>_*.zip)
# apenas as linhas de Presidente e grava um JSON compacto por UF e turno.
# Uso: python tools/analise/extrair_bweb.py <links.txt> <pasta_saida> [1|2]
# Baixa um estado por vez e apaga o zip em seguida: o 1º turno tem ~4,8 GB por incluir
# todos os cargos, e só precisamos de Presidente.
import csv, io, json, sys, time, zipfile, urllib.request
from pathlib import Path

links = [l.strip() for l in open(sys.argv[1]) if l.strip()]
saida = Path(sys.argv[2]); saida.mkdir(parents=True, exist_ok=True)
turnos = sys.argv[3:] or ['1', '2']

def baixar(url, destino, tentativas=5):
    for i in range(tentativas):
        try:
            with urllib.request.urlopen(url, timeout=120) as r, open(destino, 'wb') as f:
                while True:
                    bloco = r.read(1 << 20)
                    if not bloco: break
                    f.write(bloco)
            return
        except Exception as e:
            print('  falhou', i + 1, e, flush=True); time.sleep(5 * (i + 1))
    raise RuntimeError('não baixou ' + url)

for url in links:
    nome = url.rsplit('/', 1)[1]
    turno, uf = nome.split('_')[1][0], nome.split('_')[2]
    if turno not in turnos: continue
    alvo = saida / f't{turno}_{uf}.json'
    if alvo.exists(): continue
    zipf = saida / nome
    t0 = time.time(); baixar(url, zipf)
    secoes = {}
    with zipfile.ZipFile(zipf) as zf:
        csvnome = [n for n in zf.namelist() if n.lower().endswith('.csv')][0]
        with zf.open(csvnome) as f:
            for l in csv.DictReader(io.TextIOWrapper(f, encoding='latin1'), delimiter=';'):
                if l['CD_CARGO_PERGUNTA'] != '1': continue
                k = f"{int(l['CD_MUNICIPIO'])}|{int(l['NR_ZONA'])}|{int(l['NR_SECAO'])}"
                s = secoes.get(k)
                if s is None:
                    s = secoes[k] = {
                        'mun': l['NM_MUNICIPIO'], 'local': int(l['NR_LOCAL_VOTACAO']),
                        'apt': int(l['QT_APTOS']), 'comp': int(l['QT_COMPARECIMENTO']), 'abst': int(l['QT_ABSTENCOES']),
                        'ab': l['DT_ABERTURA'], 'en': l['DT_ENCERRAMENTO'], 'tipo': l['DS_TIPO_URNA'],
                        'agr': '' if l['DS_SECOES_AGREGADAS'] in ('#NULO#', '-1') else l['DS_SECOES_AGREGADAS'],
                        'urna': l['NR_URNA_EFETIVADA'], 'v': {},
                    }
                s['v'][l['NR_VOTAVEL']] = s['v'].get(l['NR_VOTAVEL'], 0) + int(l['QT_VOTOS'])
    json.dump(secoes, open(alvo, 'w'), ensure_ascii=False, separators=(',', ':'))
    zipf.unlink()
    print(f'{nome}: {len(secoes)} seções em {time.time() - t0:.0f} s', flush=True)
