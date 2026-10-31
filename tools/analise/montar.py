# Junta os boletins dos dois turnos (por seção) e as contagens dos logs e grava os dados
# estáticos da página /analise em public/analise/dados/.
#
# Uso: python tools/analise/montar.py <pasta compact> <logs_t2.json> <mun-e006258-cm.json> <saida> [br-c0001-e006257-u.json] [pasta bio]
#
# Arquivos gerados (todos JSON):
#   resumo.json            Brasil, regiões, UFs, candidatos do 1º turno, horários e simulador
#   uf/<UF>.json           municípios da UF (totais por turno) e listas de seções em destaque
#   mun/<UF>/<cd>.json     seções do município, 1º e 2º turno lado a lado
import collections, datetime, json, math, sys
from pathlib import Path

pasta, logs_arq, cfg_arq, saida = map(Path, sys.argv[1:5])
REGIOES = {
    'Norte': ['AC', 'AM', 'AP', 'PA', 'RO', 'RR', 'TO'],
    'Nordeste': ['AL', 'BA', 'CE', 'MA', 'PB', 'PE', 'PI', 'RN', 'SE'],
    'Centro-Oeste': ['DF', 'GO', 'MS', 'MT'],
    'Sudeste': ['ES', 'MG', 'RJ', 'SP'],
    'Sul': ['PR', 'RS', 'SC'],
    'Exterior': ['ZZ'],
}
REGIAO_DA_UF = {uf: r for r, ufs in REGIOES.items() for uf in ufs}

# Municípios: código TSE -> IBGE e nome (config oficial do TSE).
cfg = json.load(open(cfg_arq))
MUN = {}
for a in cfg['abr']:
    for m in a['mu']:
        MUN[(a['cd'].upper(), int(m['cd']))] = {'nome': m['nm'], 'ibge': m.get('cdi') or None}

# Nomes dos candidatos do 1º turno, do resultado oficial nacional (opcional, 5º argumento).
nomes1 = {}
if len(sys.argv) > 5:
    def visitar(o, sigla=None):
        if isinstance(o, list):
            for x in o: visitar(x, sigla)
        elif isinstance(o, dict):
            sg = o.get('sg') if isinstance(o.get('cand'), list) else sigla
            for c in o.get('cand', []) or []: nomes1[str(c['n'])] = {'nome': c.get('nmu') or c.get('nm'), 'sigla': sg}
            for k, v in o.items():
                if k != 'cand' and isinstance(v, (dict, list)): visitar(v, sg)
    visitar(json.load(open(sys.argv[5])))
# Biometria por seção (tools/analise/extrair_biometria.py), opcional: 6º argumento.
BIO = Path(sys.argv[6]) if len(sys.argv) > 6 else None
logs = json.load(open(logs_arq))
meta_logs = logs.pop('_meta', {})

def fusos(secoes):
    # Todas as urnas abrem às 8h de Brasília: a hora local de abertura mais comum no
    # município dá a diferença de fuso para converter os horários para Brasília.
    c = collections.defaultdict(collections.Counter)
    for k, s in secoes.items():
        if s['ab'][:4].isdigit(): c[k.split('|')[0]][int(s['ab'][11:13])] += 1
    return {m: 8 - v.most_common(1)[0][0] for m, v in c.items() if v}

def minuto_brasilia(txt, fz):
    if not txt[:4].isdigit(): return None
    dt = datetime.datetime.strptime(txt, '%Y-%m-%d %H:%M:%S') + datetime.timedelta(hours=fz)
    return round(dt.hour * 60 + dt.minute + dt.second / 60, 2)

def votos(s):
    # Votáveis fora da lista oficial de candidatos (ex.: 28 no 1º turno, candidatura anulada)
    # são "nulos técnicos" no resultado oficial: entram em nulos, não em outros candidatos.
    v = s['v']
    valido = lambda n: not nomes1 or n in nomes1
    out = sum(q for n, q in v.items() if n not in ('13', '22', '95', '96') and valido(n))
    tecnicos = sum(q for n, q in v.items() if n not in ('13', '22', '95', '96') and not valido(n))
    return v.get('13', 0), v.get('22', 0), out, v.get('95', 0), v.get('96', 0) + tecnicos

def novo():
    return {'t1': collections.Counter(), 't2': collections.Counter(), 'p': collections.Counter()}

def somar(ag, s1, s2, info):
    if s1:
        v13, v22, out, br, nu = votos(s1)
        ag['t1'].update({'secoes': 1, 'apt': s1['apt'], 'comp': s1['comp'], 'abst': s1['abst'], '13': v13, '22': v22, 'out': out, 'br': br, 'nu': nu, 'sb': s1.get('sb') or 0})
    if s2:
        v13, v22, out, br, nu = votos(s2)
        ag['t2'].update({'secoes': 1, 'apt': s2['apt'], 'comp': s2['comp'], 'abst': s2['abst'], '13': v13, '22': v22, 'br': br, 'nu': nu, 'sb': s2.get('sb') or 0})
        en = info.get('en')
        if en is not None and en > 17 * 60 + 15: ag['p'].update({'prorrogadas': 1, 'comp_prorrogadas': s2['comp'], '13_prorrogadas': v13, '22_prorrogadas': v22})
        elif en is not None and en > 17 * 60: ag['p'].update({'fila': 1})  # fechou entre 17:00 e 17:15 (fila)
        lg = info.get('log')
        if lg and 'erro' not in lg and lg['grupo'] == 'prorrogada':
            ag['p'].update({'pos17': lg['pos17'], 'contadas': 1})
            # Log com menos votos que o boletim (urna substituída, cédula): a contagem é um piso;
            # o teto soma os votos que faltam no log como se todos fossem depois das 17h.
            if lg['votos'] < s2['comp']: ag['p'].update({'logs_parciais': 1, 'pos17_teto_extra': s2['comp'] - lg['votos']})

def plano(ag):
    return {k: dict(v) for k, v in ag.items()}

# Faixas de encerramento (Brasília) para o simulador e os gráficos: 5 em 5 minutos a
# partir das 16:30; antes disso tudo cai na primeira faixa.
def faixa(en):
    if en is None: return 'sem'
    m = int(en // 5 * 5)
    return str(max(16 * 60 + 30, min(m, 20 * 60)))

br, regs, ufs = novo(), collections.defaultdict(novo), collections.defaultdict(novo)
CIDADES = []          # uma linha por município do país (aba Cidades)
EXTREMAS = []         # seções candidatas a extremo nacional (queda de Flávio / ganho de margem de Lula)
cand1 = collections.Counter()
sim = collections.defaultdict(lambda: collections.defaultdict(collections.Counter))  # uf -> faixa -> somas
amostra_fila = []  # votos pós-17h por seção da amostra 17:00–17:15
destaques = collections.defaultdict(lambda: {'prorrogadas': [], 'variacao': []})
(saida / 'uf').mkdir(parents=True, exist_ok=True)

todas_ufs = sorted({p.stem.split('_')[1] for p in pasta.glob('t*_*.json')})
for uf in todas_ufs:
    t1 = json.load(open(pasta / f't1_{uf}.json')) if (pasta / f't1_{uf}.json').exists() else {}
    t2 = json.load(open(pasta / f't2_{uf}.json')) if (pasta / f't2_{uf}.json').exists() else {}
    fz = fusos(t2) if uf != 'ZZ' else {}
    if BIO:
        for turno, dados in ((1, t1), (2, t2)):
            arq = BIO / f'bio_t{turno}_{uf}.json'
            if arq.exists():
                for k, (q, _, _) in json.load(open(arq)).items():
                    if k in dados: dados[k]['sb'] = q
    for s in t1.values():
        for n, q in s['v'].items(): cand1[n] += q
    municipios = collections.defaultdict(novo)
    secoes_mun = collections.defaultdict(list)
    for k in sorted(set(t1) | set(t2), key=lambda k: tuple(int(x) for x in k.split('|'))):
        mun, zona, sec = (int(x) for x in k.split('|'))
        s1, s2 = t1.get(k), t2.get(k)
        info = {}
        if s2 and uf != 'ZZ': info['en'] = minuto_brasilia(s2['en'], fz.get(str(mun), 0)); info['ab'] = minuto_brasilia(s2['ab'], fz.get(str(mun), 0))
        info['log'] = logs.get(f'{uf}|{mun}|{zona}|{sec}')
        for ag in (br, regs[REGIAO_DA_UF[uf]], ufs[uf], municipios[mun]): somar(ag, s1, s2, info)
        if s2:
            v13, v22, _, _, _ = votos(s2)
            c = sim[uf][faixa(info.get('en'))]
            c.update({'secoes': 1, 'comp': s2['comp'], '13': v13, '22': v22})
            lg = info['log']
            if lg and 'erro' not in lg:
                if lg['grupo'] == 'prorrogada':
                    c.update({'pos17': lg['pos17'], 'contadas': 1})
                    if lg['votos'] < s2['comp']: c.update({'pos17_teto_extra': s2['comp'] - lg['votos']})
                else: amostra_fila.append(lg['pos17'])
        # Linha compacta da seção: ver CAMPOS_SECAO abaixo.
        def t(s):
            if not s: return None
            v13, v22, out, b, n = votos(s)
            return [s['apt'], s['comp'], v13, v22, out, b, n, s['local'], s['agr'] or 0, s.get('sb')]
        lg = info.get('log')
        pos17 = None if not lg or 'erro' in lg else lg['pos17']
        parcial = 1 if lg and 'erro' not in lg and s2 and lg['votos'] < s2['comp'] else 0
        ultimo = None if not lg or 'erro' in lg or lg.get('ultimo') is None else round(lg['ultimo'], 1)
        linha = [zona, sec, t(s1), t(s2), info.get('ab'), info.get('en'), pos17, ultimo, parcial]
        secoes_mun[mun].append(linha)
        # Destaques por UF: seções prorrogadas e maiores variações de margem entre turnos.
        if s2 and info.get('en') and info['en'] > 17 * 60 + 15:
            destaques[uf]['prorrogadas'].append([mun, zona, sec, info['en'], s2['comp'], *votos(s2)[:2], pos17, parcial])
        if s1 and s2 and s1['comp'] >= 50 and s2['comp'] >= 50:
            a13, a22, *_ = votos(s1); b13, b22, *_ = votos(s2)
            v1, v2 = a13 + a22 + votos(s1)[2], b13 + b22
            if v1 and v2:
                dm = 100 * (b13 - b22) / v2 - 100 * (a13 - a22) / v1
                destaques[uf]['variacao'].append([mun, zona, sec, round(dm, 2)])
                # Extremos nacionais: guarda o essencial para comparar sem abrir o município.
                EXTREMAS.append([uf, mun, zona, sec, a13, a22, votos(s1)[2], s1['comp'], b13, b22, s2['comp'], round(dm, 2), int(s1['agr'] != s2['agr'])])
    # Arquivos do município (seções) e da UF (municípios + destaques).
    # Cidades: [uf, cd, nome, ibge, aptos1, comp1, lula1, flavio1, outros1, brnu1, aptos2, comp2, lula2, flavio2, brnu2]
    for m, ag in municipios.items():
        t1, t2 = ag['t1'], ag['t2']
        if not t1 or not t2: continue
        info = MUN.get((uf, m), {})
        CIDADES.append([uf, m, info.get('nome'), info.get('ibge'), t1['apt'], t1['comp'], t1['13'], t1['22'], t1['out'], t1['br'] + t1['nu'],
                        t2['apt'], t2['comp'], t2['13'], t2['22'], t2['br'] + t2['nu']])
    (saida / 'mun' / uf).mkdir(parents=True, exist_ok=True)
    for mun, linhas in secoes_mun.items():
        json.dump({'uf': uf, 'cd': mun, 'nome': MUN.get((uf, mun), {}).get('nome'), 'secoes': linhas},
                  open(saida / 'mun' / uf / f'{mun}.json', 'w'), ensure_ascii=False, separators=(',', ':'))
    dest = destaques[uf]
    dest['prorrogadas'].sort(key=lambda x: -x[3])
    dest['variacao'].sort(key=lambda x: x[3])
    json.dump({
        'uf': uf,
        'municipios': {str(m): {**MUN.get((uf, m), {'nome': None, 'ibge': None}), **plano(ag)} for m, ag in municipios.items()},
        'prorrogadas': dest['prorrogadas'],
        'maior_virada_13': dest['variacao'][-40:][::-1],  # maior ganho de margem do 13
        'maior_virada_22': dest['variacao'][:40],         # maior ganho de margem do 22
    }, open(saida / 'uf' / f'{uf}.json', 'w'), ensure_ascii=False, separators=(',', ':'))
    print(uf, len(set(t1) | set(t2)), 'seções', flush=True)

# Estimativa dos votos depois das 17h nas seções que fecharam entre 17:00 e 17:15:
# média da amostra aleatória x população, com intervalo de 95% (aproximação normal).
n = len(amostra_fila); N = meta_logs.get('populacao_fila', 0)
media = sum(amostra_fila) / n if n else 0
dp = math.sqrt(sum((x - media) ** 2 for x in amostra_fila) / (n - 1)) if n > 1 else 0
erro = 1.96 * dp / math.sqrt(n) * math.sqrt(1 - n / N) if n and N else 0
contados = sum(c['pos17'] for u in sim.values() for c in u.values())

CAMPOS_SECAO = ['zona', 'secao', 't1', 't2', 'abertura_min', 'encerramento_min', 'votos_pos17', 'ultimo_voto_min', 'log_parcial']
CAMPOS_TURNO = ['aptos', 'comparecimento', 'v13', 'v22', 'outros', 'brancos', 'nulos', 'local', 'agregadas', 'sem_biometria']
json.dump({'campos': ['uf', 'cd', 'nome', 'ibge', 'aptos1', 'comp1', 'lula1', 'flavio1', 'outros1', 'brnu1', 'aptos2', 'comp2', 'lula2', 'flavio2', 'brnu2'], 'cidades': CIDADES},
          open(saida / 'cidades.json', 'w'), ensure_ascii=False, separators=(',', ':'))
# Seções extremas do país: as 300 maiores quedas de Flávio em votos e as 300 maiores
# variações de margem para cada lado (seções com pelo menos 50 votantes nos dois turnos).
campos_ext = ['uf', 'mun', 'zona', 'secao', 'lula1', 'flavio1', 'outros1', 'comp1', 'lula2', 'flavio2', 'comp2', 'dmargem', 'agregacao_mudou']
json.dump({'campos': campos_ext,
           'queda_flavio': sorted(EXTREMAS, key=lambda x: x[9] - x[5])[:300],
           'queda_lula': sorted(EXTREMAS, key=lambda x: x[8] - x[4])[:300],
           'margem_lula': sorted(EXTREMAS, key=lambda x: -x[11])[:300],
           'margem_flavio': sorted(EXTREMAS, key=lambda x: x[11])[:300],
           'nomes': {f'{uf}|{m}': v['nome'] for (uf, m), v in MUN.items()}},
          open(saida / 'secoes_extremas.json', 'w'), ensure_ascii=False, separators=(',', ':'))
json.dump({
    'gerado': datetime.datetime.now().strftime('%Y-%m-%d %H:%M'),
    'campos_secao': CAMPOS_SECAO, 'campos_turno': CAMPOS_TURNO,
    'br': plano(br), 'regioes': {r: plano(a) for r, a in regs.items()}, 'ufs': {u: plano(a) for u, a in ufs.items()},
    'candidatos_t1': [{'n': n, 'votos': q, **nomes1.get(n, {})} for n, q in cand1.most_common() if n not in ('95', '96')],
    'simulador': {u: {f: dict(c) for f, c in fx.items()} for u, fx in sim.items()},
    'pos17': {
        'prorrogadas_contadas': contados,
        'fila': {'populacao': N, 'amostra': n, 'media': media, 'desvio': dp, 'estimativa': media * N, 'margem95': erro * N, 'semente': meta_logs.get('semente')},
        'gerado_logs': meta_logs.get('gerado'),
    },
}, open(saida / 'resumo.json', 'w'), ensure_ascii=False, separators=(',', ':'))
print('ok')
