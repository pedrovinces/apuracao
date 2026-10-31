# Verificação de assinaturas EdDSA na curva E-521 ("Ed521"), usada pelas urnas modelo 2020 e 2022
# e pelas autoridades certificadoras das urnas do TSE.
#
# Curva de Edwards x² + y² = 1 + d·x²·y² sobre o corpo de p = 2^521 − 1, com d = −376014
# (curva E-521, de Aranha, Barreto, Pereira e Ricardini). Gerador com y = 12 e x par.
# Hash: SHAKE256 com saída de 132 bytes; pontos e escalares em 66 bytes little-endian;
# o bit mais alto do último byte guarda a paridade de x (mesma convenção do Ed25519/Ed448).
# Prefixo de domínio "SigEd521" + flag 0 + contexto vazio, conferido em arquivos reais de urna.
# A implementação confere a si mesma ao carregar: gerador na curva e ordem do gerador.
import hashlib

P = 2 ** 521 - 1
D = -376014 % P
N = 2 ** 519 - 337554763258501705789107630418782636071904961214051226618635150085779108655765
GX = 0x752cb45c48648b189df90cb2296b2878a3bfd9f42fc6c818ec8bf3c9c0c6203913f6ecc5ccc72434b1ae949d568fc99c6059d0fb13364838aa302a940a2f19ba6c
GY = 12
TAM = 66
DOM = b'SigEd521\x00\x00'  # prefixo de domínio: flag 0 (assinatura pura), contexto vazio

# coordenadas projetivas estendidas (X, Y, Z, T), x = X/Z, y = Y/Z, x·y = T/Z
def _soma(a, b):
    x1, y1, z1, t1 = a; x2, y2, z2, t2 = b
    A = x1 * x2 % P; B = y1 * y2 % P; C = D * t1 * t2 % P; Dd = z1 * z2 % P
    E = ((x1 + y1) * (x2 + y2) - A - B) % P
    F = (Dd - C) % P; G = (Dd + C) % P; H = (B - A) % P
    return (E * F % P, G * H % P, F * G % P, E * H % P)

def _mult(k, ponto):
    r = (0, 1, 1, 0)
    while k:
        if k & 1: r = _soma(r, ponto)
        ponto = _soma(ponto, ponto); k >>= 1
    return r

def _afim(pt):
    x, y, z, _ = pt; zi = pow(z, -1, P)
    return x * zi % P, y * zi % P

def _ponto(x, y):
    return (x, y, 1, x * y % P)

def decodifica(b):
    if len(b) != TAM: raise ValueError('tamanho de ponto inválido')
    v = int.from_bytes(b, 'little')
    sinal = v >> (8 * TAM - 1); y = v & ((1 << (8 * TAM - 1)) - 1)
    if y >= P: raise ValueError('y fora do corpo')
    u = (y * y - 1) * pow(D * y * y - 1, -1, P) % P
    x = pow(u, (P + 1) // 4, P)
    if x * x % P != u: raise ValueError('ponto fora da curva')
    if x & 1 != sinal: x = P - x
    if x == 0 and sinal: raise ValueError('ponto inválido')
    return _ponto(x, y)

def codifica(pt):
    x, y = _afim(pt)
    return (y | ((x & 1) << (8 * TAM - 1))).to_bytes(TAM, 'little')

B = _ponto(GX, GY)
assert (GX * GX + GY * GY - 1 - D * GX * GX * GY * GY) % P == 0, 'gerador fora da curva'
assert _afim(_mult(N, B)) == (0, 1), 'ordem do gerador incorreta'

def verifica(chave_publica: bytes, mensagem: bytes, assinatura: bytes) -> bool:
    """EdDSA (prefixo de domínio "SigEd521", sem contexto, como no Ed448): aceita se
    [S]B = R + [h]A, com h = SHAKE256(dom ‖ R ‖ A ‖ M) mod N."""
    if len(assinatura) != 2 * TAM: return False
    try:
        A = decodifica(chave_publica); R = decodifica(assinatura[:TAM])
    except ValueError:
        return False
    S = int.from_bytes(assinatura[TAM:], 'little')
    if S >= N: return False
    h = int.from_bytes(hashlib.shake_256(DOM + assinatura[:TAM] + chave_publica + mensagem).digest(2 * TAM), 'little') % N
    return _afim(_mult(S, B)) == _afim(_soma(R, _mult(h, A)))
