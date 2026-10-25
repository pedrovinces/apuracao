# Recorta o fundo das fotos oficiais de candidatura publicadas pelo TSE
# (resultados.tse.jus.br/oficial/ele2026/6258/fotos/br/<sqcand>.jpeg) e salva WebP com
# transparência em public/img. Precisa de: pip install "rembg[cpu]" pillow
# Uso: python tools/recortar-fotos.py <pasta com 13.jpeg e 22.jpeg>
import sys
from pathlib import Path
from PIL import Image
from rembg import remove, new_session

origem = Path(sys.argv[1])
sessao = new_session('isnet-general-use')
for n in ('13', '22'):
    im = Image.open(origem / f'{n}.jpeg').convert('RGB')
    # Amplia 2x antes: o modelo recorta melhor bordas finas (aba do chapéu, cabelo).
    im = im.resize((im.width * 2, im.height * 2), Image.LANCZOS)
    out = remove(im, session=sessao, alpha_matting=True, alpha_matting_foreground_threshold=240,
                 alpha_matting_background_threshold=15, alpha_matting_erode_size=6)
    out = out.resize((round(out.width * 240 / out.height), 240), Image.LANCZOS)
    out.save(f'public/img/{n}.webp', 'WEBP', quality=86, method=6)
    print(n, out.size)
