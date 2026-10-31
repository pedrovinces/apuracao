# Extrai dos boletins (bweb) a quantidade de eleitores habilitados sem biometria por seção
# (QT_ELEI_BIOM_SEM_HABILITACAO: eleitor com digital cadastrada que votou sem a digital ser
# reconhecida, liberado pelo mesário) e o horário de encerramento, para os dois turnos.
# Uso: python tools/analise/extrair_biometria.py <links.txt|pasta com zips> <saida> <turno>
import csv, io, json, sys, time, zipfile, urllib.request
from pathlib import Path
fonte, saida, turno = sys.argv[1], Path(sys.argv[2]), sys.argv[3]
saida.mkdir(parents=True, exist_ok=True)
if Path(fonte).is_dir():
    itens = [(str(p), None) for p in sorted(Path(fonte).glob(f'bweb_{turno}t_*.zip'))]
else:
    itens = [(None, l.strip()) for l in open(fonte) if f'bweb_{turno}t_' in l]
for local, url in itens:
    nome = Path(local).name if local else url.rsplit('/', 1)[1]
    uf = nome.split('_')[2]
    alvo = saida / f'bio_t{turno}_{uf}.json'
    if alvo.exists(): continue
    zipf = Path(local) if local else saida / nome
    if url:
        for i in range(5):
            try: urllib.request.urlretrieve(url, zipf); break
            except Exception as e: print('falhou', e, flush=True); time.sleep(5 * (i + 1))
    secoes = {}
    with zipfile.ZipFile(zipf) as zf:
        with zf.open([n for n in zf.namelist() if n.lower().endswith('.csv')][0]) as f:
            for l in csv.DictReader(io.TextIOWrapper(f, encoding='latin1'), delimiter=';'):
                if l['CD_CARGO_PERGUNTA'] != '1': continue
                k = f"{int(l['CD_MUNICIPIO'])}|{int(l['NR_ZONA'])}|{int(l['NR_SECAO'])}"
                if k in secoes: continue
                q = l['QT_ELEI_BIOM_SEM_HABILITACAO']
                secoes[k] = [int(q) if q.lstrip('-').isdigit() else None, int(l['QT_COMPARECIMENTO']), l['DT_ENCERRAMENTO']]
    json.dump(secoes, open(alvo, 'w'), separators=(',', ':'))
    if url: zipf.unlink()
    print(nome, len(secoes), flush=True)
