# Confere a assinatura digital (o "lacre eletrônico") dos arquivos de uma amostra de urnas,
# usando apenas arquivos públicos do TSE e os certificados públicos das autoridades
# certificadoras das urnas.
#
# Para cada seção sorteada:
#   1. baixa o boletim de urna (bu.dat) e o arquivo de assinaturas (vota.vsc) no arquivo-urna;
#   2. confere se o SHA-512 de cada arquivo bate com o hash gravado pela urna;
#   3. confere a assinatura de hardware da urna (Ed521 ou ECDSA P-521) sobre cada hash e sobre
#      a lista de hashes (autoassinatura);
#   4. confere se o certificado da urna foi emitido por uma autoridade das urnas do TSE
#      (AC UE2020, AC UE2022 ou AC URNA), cuja chave pública vem de tools/analise/certs_urna_tse.pem;
#   5. lê os votos de Presidente dentro do bu.dat assinado e compara com o número publicado
#      nos dados abertos (o mesmo usado no painel).
# A assinatura de software (algoritmo CEPESC, de uso do governo e não publicado) não é conferida.
#
# Formato dos arquivos: especificação oficial do TSE "formato-arquivos-bu-rdv-ass-digital-v2"
# (spec/bu.asn1). Nos arquivos de 2026 o vota.vsc tem o modelo da urna num bloco no fim e os
# campos opcionais com tags [0]/[1]; por isso o arquivo de assinaturas é lido por um leitor BER
# próprio, abaixo.
#
# Uso: python tools/analise/assinaturas.py <pasta compact> <bu.asn1> <saida.json> [n por turno] [estudos.json]
# Dependências: asn1tools e cryptography (a curva Ed521 está em tools/analise/ed521.py).
import collections, hashlib, json, random, sys, time, urllib.error, urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import asn1tools
from cryptography import x509
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec

sys.path.insert(0, str(Path(__file__).parent))
import ed521

pasta, bu_asn1, saida = Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3])
N = int(sys.argv[4]) if len(sys.argv) > 4 else 300
PLEITO = {1: 3220, 2: 3221}
ELEICAO = {1: 6257, 2: 6258}
BASE = 'https://resultados.tse.jus.br/oficial/ele2026/arquivo-urna/{p}/dados'
OID_ECDSA, OID_ED521 = '1.2.840.10045.2.1', '1.3.6.1.4.1.44588.2.1'

# ---------- leitor BER mínimo ----------
def tlv(b, i):
    t = b[i]; i += 1
    if t & 0x1F == 0x1F:  # tag longa
        while b[i] & 0x80: i += 1
        i += 1
    ln = b[i]; i += 1
    if ln & 0x80:
        n = ln & 0x7F; ln = int.from_bytes(b[i:i + n], 'big'); i += n
    return t, i, ln

def filhos(b, i, fim):
    out = []
    while i < fim:
        t, j, ln = tlv(b, i)
        out.append((t, j, ln)); i = j + ln
    return out

val = lambda b, x: bytes(b[x[1]:x[1] + x[2]])
inteiro = lambda b, x: int.from_bytes(val(b, x), 'big')

def entidade(b, x):
    k = filhos(b, x[1], x[1] + x[2])
    auto = filhos(b, k[2][1], k[2][1] + k[2][2])
    alg = filhos(b, auto[2][1], auto[2][1] + auto[2][2])
    dig = filhos(b, auto[3][1], auto[3][1] + auto[3][2])
    e = {'alg': inteiro(b, alg[0]), 'hash': val(b, dig[1]), 'ass': val(b, dig[2]),
         'conteudo': val(b, k[3]), 'cert': None, 'arquivos': {}}
    for t, j, ln in k[4:]:
        if t in (0x81, 0x04): e['cert'] = bytes(b[j:j + ln])
    c = e['conteudo']
    raiz = filhos(c, 0, len(c))
    lista = filhos(c, raiz[0][1], raiz[0][1] + raiz[0][2])
    if len(lista) == 1:
        sub = filhos(c, lista[0][1], lista[0][1] + lista[0][2])
        if sub and sub[0][0] == 0x30: lista = sub  # nível extra do SEQUENCE OF
    for _, j, ln in lista:
        a = filhos(c, j, j + ln)
        d = filhos(c, a[1][1], a[1][1] + a[1][2])
        e['arquivos'][val(c, a[0]).decode('latin1')] = (val(c, d[1]), val(c, d[2]))
    return e

def ler_vsc(raw):
    t, i, ln = tlv(raw, 0)
    fs = filhos(raw, i, i + ln)
    modelo = None
    if fs[0][0] == 0x0A: modelo = inteiro(raw, fs[0]); fs = fs[1:]  # spec v2: modelo no início
    ents = [f for f in fs if f[0] == 0x30 and f[2] > 16]
    for f in fs:
        if f[0] == 0x30 and f[2] <= 16:  # 2026: SEQUENCE { modelo, algoritmo } no fim
            sub = filhos(raw, f[1], f[1] + f[2])
            if sub and sub[0][0] == 0x0A: modelo = inteiro(raw, sub[0])
    return modelo, entidade(raw, ents[0]), entidade(raw, ents[1])

# ---------- certificados ----------
def spki(der):
    # devolve (oid do algoritmo, bytes da chave pública, tbs, assinatura) de um certificado DER
    _, i, ln = tlv(der, 0)
    cert = filhos(der, i, i + ln)
    t0, j0, l0 = tlv(der, i)
    tbs_raw = der[i:j0 + l0]
    tbs = filhos(der, cert[0][1], cert[0][1] + cert[0][2])
    if tbs[0][0] == 0xA0: tbs = tbs[1:]
    info = filhos(der, tbs[5][1], tbs[5][1] + tbs[5][2])
    algs = filhos(der, info[0][1], info[0][1] + info[0][2])
    oid = x509.ObjectIdentifier(decodifica_oid(val(der, algs[0]))).dotted_string
    chave = val(der, info[1])[1:]
    sig = val(der, cert[2])[1:]
    emissor = tbs[2]
    return oid, chave, tbs_raw, sig, val(der, emissor)

def decodifica_oid(b):
    n = [b[0] // 40, b[0] % 40]; v = 0
    for x in b[1:]:
        v = (v << 7) | (x & 0x7F)
        if not x & 0x80: n.append(v); v = 0
    return '.'.join(map(str, n))

def nome_comum(nome_der):
    # procura o atributo CN (2.5.4.3) no Name DER
    for rdn in filhos(nome_der, 0, len(nome_der)):
        for atv in filhos(nome_der, rdn[1], rdn[1] + rdn[2]):
            a = filhos(nome_der, atv[1], atv[1] + atv[2])
            if decodifica_oid(val(nome_der, a[0])) == '2.5.4.3': return val(nome_der, a[1]).decode('utf8')
    return None

def para_der(cert):
    if cert.lstrip().startswith(b'-----BEGIN'):
        import base64
        corpo = b''.join(l for l in cert.strip().splitlines() if not l.startswith(b'-----'))
        return base64.b64decode(corpo)
    _, j, ln = tlv(cert, 0)
    return cert[:j + ln]

def chave_e_verificador(oid, chave):
    if oid == OID_ECDSA: return ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP521R1(), chave), 'ecdsa'
    if oid == OID_ED521: return chave, 'ed521'
    raise ValueError('algoritmo desconhecido ' + oid)

def verifica(ver, chave, oid, msg, sig):
    # ECDSA: a mensagem já chega resumida em SHA-512 (como no código de exemplo do TSE)
    try:
        if ver == 'ed521': return ed521.verifica(chave, msg, sig)
        chave.verify(sig, msg, ec.ECDSA(utils_prehashed()))
        return True
    except (InvalidSignature, ValueError):
        return False

def utils_prehashed():
    from cryptography.hazmat.primitives.asymmetric.utils import Prehashed
    return Prehashed(hashes.SHA512())

RAIZES = {}
pem = (Path(__file__).parent / 'certs_urna_tse.pem').read_bytes()
for bloco in pem.split(b'-----END CERTIFICATE-----')[:-1]:
    der = para_der(bloco[bloco.index(b'-----BEGIN'):] + b'-----END CERTIFICATE-----')
    oid, ch, _, _, _ = spki(der)
    _, i, ln = tlv(der, 0); cert = filhos(der, i, i + ln)
    tbs = filhos(der, cert[0][1], cert[0][1] + cert[0][2])
    if tbs[0][0] == 0xA0: tbs = tbs[1:]
    RAIZES[nome_comum(val(der, tbs[4]))] = (oid, *chave_e_verificador(oid, ch))
print('autoridades carregadas:', ', '.join(RAIZES), flush=True)

# ---------- BU ----------
CONV_BU = asn1tools.compile_files([str(bu_asn1)], codec='ber', numeric_enums=True)

def votos_presidente(raw):
    env = CONV_BU.decode('EntidadeEnvelopeGenerico', raw)
    bu = CONV_BU.decode('EntidadeBoletimUrna', env['conteudo'])
    out = collections.Counter()
    for r in bu['resultadosVotacaoPorEleicao']:
        for rv in r['resultadosVotacao']:
            for tc in rv['totaisVotosCargo']:
                cargo = tc['codigoCargo']
                if not (cargo[0] == 'cargoConstitucional' and cargo[1] == 1): continue
                for v in tc['votosVotaveis']:
                    tipo = v['tipoVoto']
                    n = str(v['identificacaoVotavel']['codigo']) if 'identificacaoVotavel' in v else {2: '95', 3: '96'}.get(tipo, 't%d' % tipo)
                    if tipo == 4: n = '96'  # nulo por cargo anulado conta como nulo
                    out[n] += v['quantidadeVotos']
    return out

# ---------- download ----------
def get(url, tentativas=6):
    for i in range(tentativas):
        try:
            with urllib.request.urlopen(url, timeout=60) as r: return r.read()
        except urllib.error.HTTPError as e:
            if e.code == 404: return None
            time.sleep(1.5 * (2 ** i) + random.random())
        except Exception:
            time.sleep(1.5 * (2 ** i) + random.random())
    return None

def conferir(alvo):
    turno, uf, mun, zona, sec, publicado = alvo
    p = PLEITO[turno]
    u, m5, z4, s4 = uf.lower(), f'{int(mun):05d}', f'{int(zona):04d}', f'{int(sec):04d}'
    base = f'{BASE.format(p=p)}/{u}/{m5}/{z4}/{s4}'
    r = {'turno': turno, 'uf': uf, 'mun': int(mun), 'zona': int(zona), 'secao': int(sec)}
    aux = get(f'{base}/p00{p}-{u}-m{m5}-z{z4}-s{s4}-aux.json')
    if not aux: r['erro'] = 'sem aux'; return r
    aux = json.loads(aux)
    arqs = {}
    for h in aux.get('hashes', []):
        if h.get('st') not in (None, 'Totalizado', 'Recebido'): pass
        for f in h.get('arq', []):
            arqs[f['nm']] = f"{base}/{h['hash']}/{f['nm']}"
    vsc_nome = next((n for n in arqs if n.endswith('.vsc')), None)
    bu_nome = next((n for n in arqs if n.endswith('-bu.dat') or n.endswith('.bu')), None)
    if not vsc_nome or not bu_nome: r['erro'] = 'sem arquivos'; r['arquivos'] = sorted(arqs); return r
    vsc, bu = get(arqs[vsc_nome]), get(arqs[bu_nome])
    if not vsc or not bu: r['erro'] = 'download'; return r
    try:
        modelo, sw, hw = ler_vsc(vsc)
    except Exception as e:
        r['erro'] = 'vsc ilegível'; return r
    r['modelo'] = modelo
    # nomes dentro do vsc vêm sem o caminho; o bu.dat publicado tem o mesmo nome
    nome_bu_vsc = next((n for n in hw['arquivos'] if n.endswith('bu.dat') or n.endswith('.bu')), None)
    h_bu, s_bu = hw['arquivos'].get(nome_bu_vsc, (None, None))
    r['hash_bu'] = h_bu == hashlib.sha512(bu).digest()
    r['hash_lista'] = hw['hash'] == hashlib.sha512(hw['conteudo']).digest()
    try:
        der = para_der(hw['cert'])
        oid, ch, tbs_raw, sig_cert, emissor_der = spki(der)
        chave, ver = chave_e_verificador(oid, ch)
        r['algoritmo'] = 'Ed521' if oid == OID_ED521 else 'ECDSA P-521'
        r['ass_bu'] = verifica(ver, chave, oid, hashlib.sha512(h_bu).digest(), s_bu) if h_bu else False
        # controle negativo: o mesmo lacre com 1 bit trocado no hash tem de ser recusado
        r['negativo_recusado'] = not verifica(ver, chave, oid, hashlib.sha512(h_bu[:-1] + bytes([h_bu[-1] ^ 1])).digest(), s_bu) if h_bu else False
        r['ass_lista'] = verifica(ver, chave, oid, hashlib.sha512(hw['hash']).digest(), hw['ass'])
        emissor = nome_comum(emissor_der); r['emissor'] = emissor
        if emissor in RAIZES:
            oid_r, chave_r, ver_r = RAIZES[emissor]
            msg = hashlib.sha512(tbs_raw).digest() if oid_r == OID_ECDSA else tbs_raw
            r['cert'] = verifica(ver_r, chave_r, oid_r, msg, sig_cert)
        else:
            r['cert'] = None
    except Exception as e:
        r['erro'] = 'certificado: ' + type(e).__name__; return r
    # votos dentro do arquivo assinado x publicado nos dados abertos
    try:
        dentro = votos_presidente(bu)
        r['votos_bu'] = {k: dentro.get(k, 0) for k in ('13', '22', '95', '96')} if turno == 2 else {k: dentro.get(k, 0) for k in ('13', '22')}
        r['votos_pub'] = {k: publicado.get(k, 0) for k in r['votos_bu']}
        r['votos_iguais'] = r['votos_bu'] == r['votos_pub']
    except Exception as e:
        r['erro'] = 'bu ilegível: ' + type(e).__name__
    return r

# ---------- amostra ----------
random.seed(20261031)
alvos = []
for turno in (1, 2):
    todas = []
    for arq in sorted(pasta.glob(f't{turno}_*.json')):
        uf = arq.stem.split('_')[1]
        if uf == 'ZZ': continue
        for k, s in json.load(open(arq)).items():
            todas.append((turno, uf, *k.split('|'), s['v']))
    alvos += random.sample(todas, N)
# seções com maiores desvios no teste de vizinhança (as mais "suspeitas"), 2º turno
extra = []
try:
    est = json.load(open(Path(sys.argv[5]))) if len(sys.argv) > 5 else None
except Exception:
    est = None
if est:
    t2 = {}
    viz = est['2026']['vizinhanca']
    for linha in viz['top_lula'][:50] + viz['top_flavio'][:50]:
        uf, mun, zona, sec = linha[:4]
        if uf not in t2: t2[uf] = json.load(open(pasta / f't2_{uf}.json'))
        s = t2[uf].get(f'{mun}|{zona}|{sec}')
        if s: extra.append((2, uf, str(mun), str(zona), str(sec), s['v']))
print('amostra aleatória:', len(alvos), '| seções de maior desvio na vizinhança:', len(extra), flush=True)

resultados = []
with ThreadPoolExecutor(8) as ex:
    for i, r in enumerate(ex.map(conferir, alvos + extra)):
        r['grupo'] = 'aleatoria' if i < len(alvos) else 'vizinhanca'
        resultados.append(r)
        if (i + 1) % 50 == 0: print(i + 1, 'seções conferidas', flush=True)

def resumo(rs):
    ok = [r for r in rs if 'erro' not in r]
    c = collections.Counter()
    for r in ok:
        c['conferidas'] += 1
        c['hash_bu'] += r['hash_bu']; c['hash_lista'] += r['hash_lista']
        c['ass_bu'] += r['ass_bu']; c['ass_lista'] += r['ass_lista']
        c['cert'] += bool(r['cert']); c['cert_sem_raiz'] += r['cert'] is None
        c['votos_iguais'] += bool(r.get('votos_iguais'))
        c['negativo_recusado'] += bool(r.get('negativo_recusado'))
        c['tudo'] += all([r['hash_bu'], r['hash_lista'], r['ass_bu'], r['ass_lista'], r['cert'], r.get('votos_iguais')])
    c['erros'] = len(rs) - len(ok)
    return dict(c)

grupos = {
    't1': [r for r in resultados if r['grupo'] == 'aleatoria' and r['turno'] == 1],
    't2': [r for r in resultados if r['grupo'] == 'aleatoria' and r['turno'] == 2],
    'vizinhanca': [r for r in resultados if r['grupo'] == 'vizinhanca'],
}
out = {
    'resumo': {g: resumo(rs) for g, rs in grupos.items()},
    'modelos': dict(collections.Counter(str(r.get('modelo')) for r in resultados if 'erro' not in r)),
    'algoritmos': dict(collections.Counter(r.get('algoritmo') for r in resultados if 'erro' not in r)),
    'emissores': dict(collections.Counter(r.get('emissor') for r in resultados if 'erro' not in r)),
    'erros': [r for r in resultados if 'erro' in r],
    'falhas': [r for r in resultados if 'erro' not in r and not all([r['hash_bu'], r['hash_lista'], r['ass_bu'], r['ass_lista'], r['cert'], r.get('votos_iguais')])],
    'secoes': [[r['turno'], r['uf'], r['mun'], r['zona'], r['secao'], r['grupo'][0],
                int(all([r['hash_bu'], r['hash_lista'], r['ass_bu'], r['ass_lista'], bool(r['cert']), bool(r.get('votos_iguais'))]))]
               for r in resultados if 'erro' not in r],
    'semente': 20261031,
    'gerado': time.strftime('%Y-%m-%d %H:%M'),
}
json.dump(out, open(saida, 'w'), ensure_ascii=False, separators=(',', ':'))
print(json.dumps(out['resumo'], ensure_ascii=False, indent=1))
print('modelos', out['modelos'], 'algoritmos', out['algoritmos'], 'emissores', out['emissores'])
print('erros', len(out['erros']), 'falhas', len(out['falhas']))
