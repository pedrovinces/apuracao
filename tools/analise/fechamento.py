# Horário de encerramento x resultado: a "escada" (urnas que fecham mais tarde votam mais em Lula)
# e os testes que separam o horário do lugar da seção.
#   - decis: seções ordenadas pelo encerramento (Brasília) em 10 grupos de mesmo tamanho;
#   - mesma escola: posição de cada seção no fechamento dentro do seu local de votação x diferença
#     do % de Lula para o próprio local (o lugar fica fixo; só o horário varia);
#   - limiar 17:01: nos locais com seções dos dois lados, Lula nas que fecharam depois menos antes;
#   - mesma seção nos dois turnos: ganho de Lula conforme fechou cedo/tarde em cada turno;
#   - efeito mínimo que uma alteração restrita às urnas fechadas depois das 17:01 exigiria.
# Exterior fora (outros fusos). Uso:
#   python tools/analise/fechamento.py <compact2026> <compact2022> <saida fechamento.json>
import collections, datetime, json, statistics, sys
from pathlib import Path

c26, c22, saida = map(Path, sys.argv[1:4])

def data_hora(t):
    for f in ('%Y-%m-%d %H:%M:%S', '%d/%m/%Y %H:%M:%S'):
        try: return datetime.datetime.strptime(t, f)
        except (ValueError, TypeError): pass
    return None

def carrega(pasta, turno):
    out = {}
    for arq in sorted(pasta.glob(f't{turno}_*.json')):
        uf = arq.stem.split('_')[1]
        if uf == 'ZZ': continue
        d = json.load(open(arq))
        # Todas as urnas abrem às 8h de Brasília: fuso = 8 - hora local de abertura mais comum no município.
        cont = collections.defaultdict(collections.Counter)
        for k, s in d.items():
            a = data_hora(s['ab'])
            if a: cont[k.split('|')[0]][a.hour] += 1
        fz = {m: 8 - v.most_common(1)[0][0] for m, v in cont.items()}
        for k, s in d.items():
            a, e = data_hora(s['ab']), data_hora(s['en'])
            if not a or not e: continue
            e += datetime.timedelta(hours=fz.get(k.split('|')[0], 0))
            seg = e.hour * 3600 + e.minute * 60 + e.second + 86400 * (e.date() - a.date()).days
            val = sum(q for n, q in s['v'].items() if n not in ('95', '96'))
            out[(uf, k)] = {'en': seg, 'l': s['v'].get('13', 0), 'f': s['v'].get('22', 0), 'val': val, 'comp': s['comp'],
                            'local': (uf, *k.split('|')[:2], s['local'])}
    return out

def decis(secs):
    xs = sorted(secs.values(), key=lambda s: s['en']); n = len(xs); r = []
    for i in range(10):
        g = xs[i * n // 10:(i + 1) * n // 10]
        L, F, V = (sum(s[c] for s in g) for c in ('l', 'f', 'val'))
        r.append({'de': g[0]['en'], 'ate': g[-1]['en'], 'secoes': len(g), 'lula': round(100 * L / V, 2), 'flavio': round(100 * F / V, 2),
                  'dif': round(100 * (L - F) / V, 2), 'comp': round(statistics.fmean(s['comp'] for s in g), 1)})
    L, F, V = (sum(s[c] for s in xs) for c in ('l', 'f', 'val'))
    return {'grupos': r, 'lula': round(100 * L / V, 2), 'secoes': n}

def mesma_escola(secs):
    loc = collections.defaultdict(list)
    for s in secs.values():
        if s['val'] >= 50: loc[s['local']].append(s)
    pares = []
    for g in loc.values():
        if len(g) < 2: continue
        ml = sum(s['l'] for s in g) / sum(s['val'] for s in g); me = statistics.fmean(s['en'] for s in g)
        mc = statistics.fmean(s['comp'] for s in g)
        for s in g: pares.append((s['en'] - me, 100 * (s['l'] / s['val'] - ml), s['comp'] - mc))
    pares.sort(); n = len(pares)
    return {'secoes': n, 'grupos': [{'min': round(statistics.fmean(p[0] for p in g) / 60, 2), 'lula_pp': round(statistics.fmean(p[1] for p in g), 3),
                                     'comp': round(statistics.fmean(p[2] for p in g), 1)} for g in (pares[i * n // 10:(i + 1) * n // 10] for i in range(10))]}

def limiar(secs, lim):
    loc = collections.defaultdict(lambda: {'c': [0, 0, 0], 't': [0, 0, 0]})
    for s in secs.values():
        if s['val'] < 50: continue
        g = loc[s['local']]['t' if s['en'] > lim else 'c']; g[0] += s['l']; g[1] += s['val']; g[2] += 1
    difs = [100 * (g['t'][0] / g['t'][1] - g['c'][0] / g['c'][1]) for g in loc.values() if g['c'][2] and g['t'][2]]
    return {'locais': len(difs), 'dif': round(statistics.fmean(difs), 3), 'margem95': round(1.96 * statistics.pstdev(difs) / len(difs) ** .5, 3)}

def mesma_secao(t1, t2, lim):
    cel = collections.defaultdict(list)
    for k, b in t2.items():
        a = t1.get(k)
        if not a or a['val'] < 50 or b['val'] < 50: continue
        cel[('cedo' if a['en'] <= lim else 'tarde') + '_' + ('cedo' if b['en'] <= lim else 'tarde')].append(100 * (b['l'] / b['val'] - a['l'] / a['val']))
    return {k: {'secoes': len(v), 'lula_pp': round(statistics.fmean(v), 2)} for k, v in sorted(cel.items())}

T1701, T1702, T1703 = 17 * 3600 + 60, 17 * 3600 + 120, 17 * 3600 + 180
a1, a2 = carrega(c26, 1), carrega(c26, 2)
b1, b2 = carrega(c22, 1), carrega(c22, 2)
L, F = sum(s['l'] for s in a2.values()), sum(s['f'] for s in a2.values())
tarde = [s for s in a2.values() if s['en'] > T1701]
out = {
    'decis': {'2026_t2': decis(a2), '2026_t2_SP': decis({k: v for k, v in a2.items() if k[0] == 'SP'}), '2026_t1': decis(a1),
              '2022_t2': decis(b2), '2022_t1': decis(b1)},
    'mesma_escola': {'2026_t2': mesma_escola(a2), '2026_t2_SP': mesma_escola({k: v for k, v in a2.items() if k[0] == 'SP'}),
                     '2026_t1': mesma_escola(a1), '2022_t2': mesma_escola(b2)},
    'limiar': {'2026_t2_1701': limiar(a2, T1701), '2026_t2_1703': limiar(a2, T1703), '2026_t1_1701': limiar(a1, T1701)},
    'mesma_secao': mesma_secao(a1, a2, T1702),
    'necessario': {'margem': L - F, 'secoes_depois_1701': len(tarde), 'pct_secoes': round(100 * len(tarde) / len(a2), 1),
                   'lula_pp': round(100 * ((L - F) / 2) / sum(s['val'] for s in tarde), 2)},
    'gerado': datetime.datetime.now().strftime('%Y-%m-%d %H:%M'),
}
json.dump(out, open(saida, 'w'), ensure_ascii=False, separators=(',', ':'))
print(json.dumps({k: out[k] for k in ('limiar', 'mesma_secao', 'necessario')}, ensure_ascii=False, indent=1))
for k, v in out['mesma_escola'].items(): print(k, [g['lula_pp'] for g in v['grupos']])
