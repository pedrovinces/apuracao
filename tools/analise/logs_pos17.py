# Conta, nos logs das urnas do 2º turno (arquivo-urna público do TSE), quantos votos foram
# computados depois das 17h de Brasília em cada seção. Do log só guardamos contagens:
# o arquivo traz dados pessoais (ex.: título do mesário no encerramento) que não saem daqui.
#
# Seções analisadas:
#  - todas as que encerraram depois das 17:15 de Brasília (as que usaram a prorrogação);
#  - uma amostra aleatória (semente fixa) das que encerraram entre 17:01 e 17:15, para estimar
#    os votos de fila depois das 17h nesse grupo, com margem de erro.
# Uso: python tools/analise/logs_pos17.py <pasta compact> <saida.json> [tamanho_amostra]
import io, json, random, sys, time, zipfile, datetime, collections, threading, urllib.request, urllib.error
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

pasta = Path(sys.argv[1]); saida = Path(sys.argv[2]); N_AMOSTRA = int(sys.argv[3]) if len(sys.argv) > 3 else 2500
BASE = 'https://resultados.tse.jus.br/oficial/ele2026/arquivo-urna/3221/dados'
DIA = '25/10/2026'

def fusos(secoes):
    # Todas as urnas abrem às 8h de Brasília: a hora local de abertura mais comum no
    # município dá a diferença de fuso (AC +2 h, AM/MT/MS/RO/RR +1 h, Noronha -1 h).
    c = collections.defaultdict(collections.Counter)
    for k, s in secoes.items():
        if s['ab'][:4].isdigit(): c[k.split('|')[0]][int(s['ab'][11:13])] += 1
    return {m: 8 - v.most_common(1)[0][0] for m, v in c.items() if v}

def minuto_brasilia(dt_txt, fuso):
    dt = datetime.datetime.strptime(dt_txt, '%Y-%m-%d %H:%M:%S') + datetime.timedelta(hours=fuso)
    return dt.hour * 60 + dt.minute + dt.second / 60

alvos = []  # (uf, mun, zona, secao, grupo, fuso)
estrato = collections.Counter()
for arq in sorted(pasta.glob('t2_*.json')):
    uf = arq.stem.split('_')[1]
    if uf == 'ZZ': continue
    secoes = json.load(open(arq)); fz = fusos(secoes)
    for k, s in secoes.items():
        mun = k.split('|')[0]; f = fz.get(mun, 0)
        m = minuto_brasilia(s['en'], f)
        if m > 17 * 60 + 15: alvos.append((uf, *k.split('|'), 'prorrogada', f))
        elif m > 17 * 60: estrato['fila'] += 1; alvos.append((uf, *k.split('|'), 'fila', f))
fila = [a for a in alvos if a[4] == 'fila']
random.seed(20261025)
amostra = set(random.sample(range(len(fila)), min(N_AMOSTRA, len(fila))))
alvos = [a for a in alvos if a[4] == 'prorrogada'] + [fila[i] for i in sorted(amostra)]
print('seções prorrogadas:', sum(1 for a in alvos if a[4] == 'prorrogada'), '| população 17:01–17:15:', len(fila), '| amostra:', len(amostra), flush=True)

def get(url, tentativas=6):
    for i in range(tentativas):
        try:
            with urllib.request.urlopen(url, timeout=60) as r: return r.read()
        except urllib.error.HTTPError as e:
            if e.code == 404: return None
            time.sleep(1.5 * (2 ** i) + random.random())  # 429 e afins: espera crescente
        except Exception:
            time.sleep(1.5 * (2 ** i) + random.random())
    return None

def processar(a):
    uf, mun, zona, sec, grupo, fz = a
    u, m5, z4, s4 = uf.lower(), f'{int(mun):05d}', f'{int(zona):04d}', f'{int(sec):04d}'
    pasta_sec = f'{BASE}/{u}/{m5}/{z4}/{s4}'
    aux = get(f'{pasta_sec}/p003221-{u}-m{m5}-z{z4}-s{s4}-aux.json')
    if not aux: return a, {'erro': 'sem aux'}
    aux = json.loads(aux)
    res = {'grupo': grupo, 'votos': 0, 'pos17': 0, 'hist': collections.Counter(), 'ultimo': None, 'logs': 0}
    for h in aux.get('hashes', []):
        for f in h.get('arq', []):
            if f.get('tp') != 'log': continue
            dado = get(f"{pasta_sec}/{h['hash']}/{f['nm']}")
            if not dado: continue
            res['logs'] += 1
            with zipfile.ZipFile(io.BytesIO(dado)) as zf:
                for nome in zf.namelist():
                    for linha in zf.read(nome).decode('latin1').splitlines():
                        if not linha.startswith(DIA) or 'O voto do eleitor foi computado' not in linha: continue
                        hh, mm, ss = int(linha[11:13]), int(linha[14:16]), int(linha[17:19])
                        t = (hh + fz) * 60 + mm + ss / 60  # minuto do dia em Brasília
                        res['votos'] += 1
                        if t > 17 * 60: res['pos17'] += 1
                        if t >= 16 * 60 + 30: res['hist'][int(t // 5 * 5)] += 1
                        res['ultimo'] = max(res['ultimo'] or 0, t)
    if not res['logs']: return a, {'erro': 'sem log'}
    res['hist'] = dict(res['hist'])
    return a, res

resultado = {}
if saida.exists(): resultado = json.load(open(saida))
pendentes = [a for a in alvos if f'{a[0]}|{a[1]}|{a[2]}|{a[3]}' not in resultado]
trava = threading.Lock(); feitos = 0; t0 = time.time()
with ThreadPoolExecutor(8) as ex:
    for a, res in ex.map(processar, pendentes):
        with trava:
            resultado[f'{a[0]}|{a[1]}|{a[2]}|{a[3]}'] = res; feitos += 1
            if feitos % 250 == 0:
                json.dump(resultado, open(saida, 'w'))
                print(f'{feitos}/{len(pendentes)} em {time.time() - t0:.0f} s', flush=True)
resultado['_meta'] = {'populacao_fila': len(fila), 'amostra_fila': len(amostra), 'semente': 20261025, 'gerado': time.strftime('%Y-%m-%d %H:%M')}
json.dump(resultado, open(saida, 'w'))
print('fim', len(resultado) - 1, 'seções;', sum(1 for v in resultado.values() if isinstance(v, dict) and 'erro' in v), 'com erro', flush=True)
