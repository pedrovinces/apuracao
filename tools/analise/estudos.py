# Estudos complementares da página /analise, para 2026 e para 2022 (referência):
#   - biometria: eleitores liberados sem reconhecimento da digital, por turno, UF e horário;
#   - horário de encerramento x resultado (sem e com prorrogação);
#   - seções com percentuais extremos;
#   - vizinhança: cada seção comparada com as demais do mesmo local de votação.
# Uso: python tools/analise/estudos.py <compact2026> <bio2026> <compact2022> <saida estudos.json>
import collections, datetime, glob, json, math, statistics, sys
import numpy as np
from pathlib import Path

c26, bio26, c22, saida = map(Path, sys.argv[1:5])

def data_hora(txt):
    # 2026: "2026-10-25 17:00:48"; 2022: "30/10/2022 15:00:59".
    for f in ('%Y-%m-%d %H:%M:%S', '%d/%m/%Y %H:%M:%S'):
        try: return datetime.datetime.strptime(txt, f)
        except (ValueError, TypeError): pass
    return None

def fusos(sec):
    # Todas as urnas abrem às 8h de Brasília: hora local de abertura mais comum no município - 8.
    c = collections.defaultdict(collections.Counter)
    for k, s in sec.items():
        d = data_hora(s['ab'])
        if d: c[k.split('|')[0]][d.hour] += 1
    return {m: 8 - v.most_common(1)[0][0] for m, v in c.items() if v}

def minuto(txt, fz):
    d = data_hora(txt)
    if not d: return None
    d += datetime.timedelta(hours=fz)
    return d.hour * 60 + d.minute + d.second / 60

def validos1(s, oficiais):
    return sum(q for n, q in s['v'].items() if n not in ('95', '96') and (not oficiais or n in oficiais))

def faixa(m):
    if m is None: return None
    return max(16 * 60 + 30, min(int(m // 5 * 5), 20 * 60))

def corr(a, b):
    ma, mb = statistics.fmean(a), statistics.fmean(b)
    den = math.sqrt(sum((x - ma) ** 2 for x in a) * sum((y - mb) ** 2 for y in b))
    return sum((x - ma) * (y - mb) for x, y in zip(a, b)) / den if den else 0

def estudar(pasta, bio=None, oficiais=None):
    r = {'extremos': collections.Counter(), 'bio': {'t1': collections.Counter(), 't2': collections.Counter()},
         'bio_uf': {}, 'horario': collections.defaultdict(collections.Counter)}
    pares_bio, resid, vizinhos_top = [], [], []
    for f in sorted(pasta.glob('t2_*.json')):
        uf = f.stem.split('_')[1]
        t2 = json.load(open(f)); t1 = json.load(open(pasta / f't1_{uf}.json')) if (pasta / f't1_{uf}.json').exists() else {}
        b1 = json.load(open(bio / f'bio_t1_{uf}.json')) if bio else None
        b2 = json.load(open(bio / f'bio_t2_{uf}.json')) if bio else None
        sb = lambda turno, k, s: ((b1 if turno == 1 else b2).get(k, [None])[0] if bio else s.get('sb'))
        fz = fusos(t2) if uf != 'ZZ' else {}
        ufc = {'t1': collections.Counter(), 't2': collections.Counter()}
        locais = collections.defaultdict(list)
        for k, s in t2.items():
            l2, f2 = s['v'].get('13', 0), s['v'].get('22', 0); v2 = l2 + f2
            q2 = sb(2, k, s)
            if q2 is not None: r['bio']['t2'].update({'sb': q2, 'comp': s['comp']}); ufc['t2'].update({'sb': q2, 'comp': s['comp']})
            if v2:
                if l2 / v2 >= 0.9: r['extremos']['L90_t2'] += 1
                if f2 / v2 >= 0.9: r['extremos']['F90_t2'] += 1
                if l2 == v2: r['extremos']['L100_t2'] += 1
                if f2 == v2: r['extremos']['F100_t2'] += 1
            if uf != 'ZZ':
                m = minuto(s['en'], fz.get(k.split('|')[0], 0)); fx = faixa(m)
                if fx is not None:
                    h = r['horario'][fx]; h.update({'secoes': 1, 'comp': s['comp'], '13': l2, '22': f2, 'sb': q2 or 0})
            a = t1.get(k)
            if not a: continue
            v1 = validos1(a, oficiais)
            if v1 and v2 and a['comp'] >= 50 and s['comp'] >= 50:
                pl1, pl2 = a['v'].get('13', 0) / v1, l2 / v2
                q1 = sb(1, k, a)
                if q1 is not None and q2 is not None:
                    pares_bio.append((q2 / s['comp'] - q1 / a['comp'], pl2 - pl1))
                if a.get('agr', '') == s.get('agr', '') and a.get('local') == s.get('local'):
                    outros = 100 * (v1 - a['v'].get('13', 0) - a['v'].get('22', 0)) / v1
                    dcomp = 100 * (s['comp'] - a['comp']) / a['comp']
                    locais[(k.split('|')[0], k.split('|')[1], s['local'])].append((k, 100 * (pl2 - pl1), s['comp'], a['v'].get('13', 0), a['v'].get('22', 0), l2, f2, outros, dcomp, v2))
        for k, a in t1.items():
            q1 = sb(1, k, a)
            if q1 is not None: r['bio']['t1'].update({'sb': q1, 'comp': a['comp']}); ufc['t1'].update({'sb': q1, 'comp': a['comp']})
            v1 = validos1(a, oficiais)
            if v1:
                if a['v'].get('13', 0) / v1 >= 0.9: r['extremos']['L90_t1'] += 1
                if a['v'].get('22', 0) / v1 >= 0.9: r['extremos']['F90_t1'] += 1
                if a['v'].get('13', 0) == v1: r['extremos']['L100_t1'] += 1
                if a['v'].get('22', 0) == v1: r['extremos']['F100_t1'] += 1
        r['bio_uf'][uf] = {t: (round(100 * c['sb'] / c['comp'], 3) if c['comp'] else None) for t, c in ufc.items()}
        # Vizinhança: em cada local de votação com 4+ seções comparáveis, a variação de Lula
        # (p.p. do 1º para o 2º turno) de cada seção é comparada com a mediana das vizinhas.
        for (mun, zona, local), secs in locais.items():
            if len(secs) < 4: continue
            for i, (k, d, comp, l1, f1, l2, f2, o, dc, v2) in enumerate(secs):
                viz_ = [x for j, x in enumerate(secs) if j != i]
                med = statistics.median(x[1] for x in viz_)
                # desvios da seção em relação às vizinhas: variação de Lula, estoque de votos dos
                # outros candidatos no 1º turno e variação do comparecimento
                resid.append((d - med, o - statistics.median(x[7] for x in viz_), dc - statistics.median(x[8] for x in viz_)))
                vizinhos_top.append([uf, int(mun), int(zona), int(k.split('|')[2]), int(local), len(secs), comp, l1, f1, l2, f2, round(d, 2), round(med, 2), v2])
    # Resumo da vizinhança: simetria dos desvios. Sem adulteração favorecendo um lado, desvios
    # grandes aparecem para os dois lados em quantidades parecidas. O desvio bruto é ajustado
    # pelo estoque de votos dos outros candidatos e pela variação do comparecimento (regressão
    # nacional): seção com mais votos "livres" no 1º turno naturalmente varia mais.
    R = np.array(resid) if resid else np.zeros((0, 3))
    y, X = R[:, 0], R[:, 1:]
    b = np.linalg.lstsq(X, y, rcond=None)[0] if len(R) else np.zeros(2)
    adj = y - X @ b
    lim = [3, 5, 10, 15]
    conta = lambda v: ({str(t): int((v >= t).sum()) for t in lim}, {str(t): int((v <= -t).sum()) for t in lim})
    viz = {'secoes': int(len(R)), 'coef_outros': round(float(b[0]), 3), 'coef_comparecimento': round(float(b[1]), 3)}
    viz['bruto_acima'], viz['bruto_abaixo'] = conta(y)
    viz['acima'], viz['abaixo'] = conta(adj)
    viz['hist'] = {str(k): v for k, v in sorted(collections.Counter(int(max(-20, min(20, round(x)))) for x in adj).items())}
    # Votos envolvidos: desvio ajustado (p.p.) x votos válidos da seção, nas seções com 5+ p.p.
    v2s = np.array([x[13] for x in vizinhos_top]) if vizinhos_top else np.zeros(0)
    viz['votos_acima5'] = int(round(float((adj[adj >= 5] / 100 * v2s[adj >= 5]).sum()))) if len(R) else 0
    viz['votos_abaixo5'] = int(round(float((-adj[adj <= -5] / 100 * v2s[adj <= -5]).sum()))) if len(R) else 0
    ordem = np.argsort(adj) if len(R) else []
    linha = lambda i: vizinhos_top[i][:13] + [round(float(adj[i]), 2)]
    viz['campos'] = ['uf', 'mun', 'zona', 'secao', 'local', 'secoes_no_local', 'comparecimento', 'lula1', 'flavio1', 'lula2', 'flavio2', 'var_lula', 'mediana_vizinhas', 'desvio_ajustado']
    viz['top_lula'] = [linha(int(i)) for i in ordem[::-1][:80]]
    viz['top_flavio'] = [linha(int(i)) for i in ordem[:80]]
    # Biometria x variação de Lula: decis da variação da taxa sem biometria.
    pares_bio.sort()
    n = len(pares_bio)
    decis = [{'d_taxa': round(100 * statistics.fmean(p[0] for p in g), 2), 'd_lula': round(100 * statistics.fmean(p[1] for p in g), 2)}
             for g in (pares_bio[i * n // 10:(i + 1) * n // 10] for i in range(10)) if g]
    r['bio_decis'] = decis
    r['bio_corr'] = round(corr([p[0] for p in pares_bio], [p[1] for p in pares_bio]), 4) if pares_bio else None
    r['bio'] = {t: {'sb': c['sb'], 'comp': c['comp'], 'taxa': round(100 * c['sb'] / c['comp'], 3) if c['comp'] else None} for t, c in r['bio'].items()}
    r['horario'] = {str(k): dict(v) for k, v in sorted(r['horario'].items())}
    r['extremos'] = dict(r['extremos'])
    r['vizinhanca'] = viz
    return r

# 2026: candidatos oficiais do 1º turno (o número 28 teve votos anulados, contados como nulos).
out = {
    '2026': estudar(c26, bio26, oficiais={'13', '22', '70', '14', '55', '30', '80', '16', '27', '21', '35', '29'}),
    '2022': estudar(c22, None, oficiais=None),
    'gerado': datetime.datetime.now().strftime('%Y-%m-%d %H:%M'),
}
json.dump(out, open(saida, 'w'), ensure_ascii=False, separators=(',', ':'))
for ano in ('2026', '2022'):
    e = out[ano]
    print(ano, 'bio', e['bio'], 'corr', e['bio_corr'], 'extremos', e['extremos'])
    v = e['vizinhanca']; print('   vizinhança', v['secoes'], 'coef', v['coef_outros'], v['coef_comparecimento'], 'ajustado acima', v['acima'], 'abaixo', v['abaixo'], 'votos', v['votos_acima5'], v['votos_abaixo5'])
