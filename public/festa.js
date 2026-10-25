// Comemoração em tela cheia quando o 22 vence: fogos de artifício em canvas, foto,
// "FORA PT", som sintetizado (Web Audio) e vibração. Dispara uma vez por estado
// (matematicamente definido / confirmado pelo TSE) em cada aparelho.

const CORES = ['#009c3b', '#ffdf00', '#ffffff', '#002776', '#ffe94d', '#2ecc71'];
const reduzMovimento = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// ---------- som ----------
// Navegadores só liberam áudio depois de um toque do usuário. O contexto é criado e
// "destravado" no primeiro toque em qualquer lugar da página, antes da festa começar.
let audio = null;
function destravarAudio() {
  try {
    audio = audio || new (window.AudioContext || window.webkitAudioContext)();
    if (audio.state === 'suspended') audio.resume();
  } catch { audio = null; }
}
['pointerdown', 'keydown', 'touchstart'].forEach((ev) => document.addEventListener(ev, destravarAudio, { once: false, passive: true }));
const somLiberado = () => audio && audio.state === 'running';

function estouro(t = 0, forca = 1) {
  if (!somLiberado()) return;
  const agora = audio.currentTime + t;
  const dur = 1.2;
  const buf = audio.createBuffer(1, audio.sampleRate * dur, audio.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / d.length, 3);
  const fonte = audio.createBufferSource(); fonte.buffer = buf;
  const filtro = audio.createBiquadFilter(); filtro.type = 'lowpass'; filtro.frequency.value = 900 + Math.random() * 1400;
  const ganho = audio.createGain(); ganho.gain.setValueAtTime(0.55 * forca, agora); ganho.gain.exponentialRampToValueAtTime(0.001, agora + dur);
  fonte.connect(filtro).connect(ganho).connect(audio.destination);
  fonte.start(agora);
}
function assobio(t = 0) {
  if (!somLiberado()) return;
  const agora = audio.currentTime + t;
  const o = audio.createOscillator(); o.type = 'sine';
  o.frequency.setValueAtTime(500, agora); o.frequency.exponentialRampToValueAtTime(1800, agora + 0.7);
  const g = audio.createGain(); g.gain.setValueAtTime(0.0001, agora); g.gain.exponentialRampToValueAtTime(0.06, agora + 0.1); g.gain.exponentialRampToValueAtTime(0.0001, agora + 0.75);
  o.connect(g).connect(audio.destination); o.start(agora); o.stop(agora + 0.8);
}
// Fanfarra curta composta aqui mesmo (sem música de terceiros): arpejo ascendente e acorde final.
function fanfarra() {
  if (!somLiberado()) return;
  const notas = [[523.25, 0, 0.16], [659.25, 0.16, 0.16], [783.99, 0.32, 0.16], [1046.5, 0.48, 0.5], [783.99, 1.0, 0.14], [1046.5, 1.14, 0.9]];
  const base = audio.currentTime + 0.05;
  for (const [f, t, dur] of notas) {
    for (const [tipo, vol, mult] of [['square', 0.05, 1], ['triangle', 0.09, 0.5]]) {
      const o = audio.createOscillator(); o.type = tipo; o.frequency.value = f * mult;
      const g = audio.createGain();
      g.gain.setValueAtTime(0.0001, base + t); g.gain.exponentialRampToValueAtTime(vol, base + t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, base + t + dur);
      o.connect(g).connect(audio.destination); o.start(base + t); o.stop(base + t + dur + 0.05);
    }
  }
}
// O Chrome só deixa vibrar depois de um toque na página (senão acusa erro); iPhone não vibra por site.
// Bumbo de arquibancada: seno grave com queda rápida de afinação.
function bumbo(t = 0, forca = 1) {
  if (!somLiberado()) return;
  const agora = audio.currentTime + t;
  const o = audio.createOscillator(); o.type = 'sine';
  o.frequency.setValueAtTime(130, agora); o.frequency.exponentialRampToValueAtTime(48, agora + 0.25);
  const g = audio.createGain(); g.gain.setValueAtTime(0.9 * forca, agora); g.gain.exponentialRampToValueAtTime(0.001, agora + 0.45);
  o.connect(g).connect(audio.destination); o.start(agora); o.stop(agora + 0.5);
}

// Grito de guerra da torcida: o navegador não canta, então a voz sintetizada do aparelho
// (português do Brasil, quando existir) puxa as frases no compasso do bumbo.
const FRASES = ['Eu sou brasileiro!', 'Com muito orgulho!', 'Com muito amor!'];
function vozBrasileira() {
  const vozes = window.speechSynthesis?.getVoices() || [];
  return vozes.find((v) => v.lang === 'pt-BR') || vozes.find((v) => v.lang?.startsWith('pt')) || null;
}
function gritoDeGuerra(atrasoMs = 0, vezes = 2) {
  const fala = window.speechSynthesis;
  const BATIDA = 520; // ms, ritmo de arquibancada
  const compasso = BATIDA * 4; // cada frase ocupa 4 batidas
  for (let r = 0; r < vezes; r++) {
    FRASES.forEach((frase, i) => {
      const inicio = atrasoMs + (r * FRASES.length + i) * compasso;
      // bumbo: tum . tum tum | marcando a frase
      [0, 2, 3].forEach((b) => setTimeout(() => bumbo(0, b === 0 ? 1 : 0.75), inicio + b * BATIDA));
      if (!fala) return;
      setTimeout(() => {
        const u = new SpeechSynthesisUtterance(frase);
        const voz = vozBrasileira();
        if (voz) u.voice = voz;
        u.lang = 'pt-BR'; u.rate = 1.05; u.pitch = 1.15; u.volume = 1;
        fala.speak(u);
      }, inicio);
    });
  }
  // fecho: três batidas fortes
  const fim = atrasoMs + vezes * FRASES.length * compasso;
  [0, 1, 2].forEach((b) => setTimeout(() => bumbo(0, 1), fim + b * 300));
}
// As vozes carregam depois da página em alguns navegadores; pedir cedo evita silêncio.
try { window.speechSynthesis?.getVoices(); window.speechSynthesis && (window.speechSynthesis.onvoiceschanged = () => {}); } catch { /* sem voz */ }

const vibrar = (padrao) => {
  const tocou = navigator.userActivation ? navigator.userActivation.hasBeenActive : true;
  if (!tocou) return;
  try { navigator.vibrate?.(padrao); } catch { /* sem suporte */ }
};

// ---------- fogos ----------
function fogos(canvas, duracao) {
  const ctx = canvas.getContext('2d');
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const ajustar = () => { canvas.width = innerWidth * dpr; canvas.height = innerHeight * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0); };
  ajustar(); addEventListener('resize', ajustar);
  const W = () => innerWidth, H = () => innerHeight;
  const foguetes = [], particulas = [];
  const MAX = innerWidth < 600 ? 900 : 1800; // limite para não travar celular simples
  const inicio = performance.now();
  let proximo = 0, vivo = true;

  function lancar() {
    const x = W() * (0.15 + Math.random() * 0.7);
    foguetes.push({ x, y: H(), vx: (Math.random() - 0.5) * 2, vy: -(H() * 0.016 + Math.random() * 4), cor: CORES[(Math.random() * CORES.length) | 0], alvo: H() * (0.15 + Math.random() * 0.3) });
    assobio();
  }
  function explodir(f) {
    const n = Math.min(110, MAX - particulas.length);
    const cor2 = CORES[(Math.random() * CORES.length) | 0];
    for (let i = 0; i < n; i++) {
      const a = (Math.PI * 2 * i) / n, v = 2 + Math.random() * 4.5;
      particulas.push({ x: f.x, y: f.y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, vida: 1, cor: i % 3 ? f.cor : cor2, tam: 1.6 + Math.random() * 1.8 });
    }
    estouro(0, 0.6 + Math.random() * 0.5);
    vibrar([60, 40, 90]);
  }
  function quadro(t) {
    if (!vivo) return;
    const passou = t - inicio;
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = 'rgba(0,0,0,0.22)'; ctx.fillRect(0, 0, W(), H()); // rastro que some
    ctx.globalCompositeOperation = 'lighter';
    if (passou < duracao && t > proximo) { lancar(); if (Math.random() < 0.45) lancar(); proximo = t + 280 + Math.random() * 520; }
    for (let i = foguetes.length - 1; i >= 0; i--) {
      const f = foguetes[i]; f.x += f.vx; f.y += f.vy; f.vy += 0.06;
      ctx.fillStyle = f.cor; ctx.beginPath(); ctx.arc(f.x, f.y, 2.4, 0, Math.PI * 2); ctx.fill();
      if (f.y <= f.alvo || f.vy >= 0) { explodir(f); foguetes.splice(i, 1); }
    }
    for (let i = particulas.length - 1; i >= 0; i--) {
      const p = particulas[i]; p.x += p.vx; p.y += p.vy; p.vy += 0.05; p.vx *= 0.985; p.vy *= 0.985; p.vida -= 0.012;
      if (p.vida <= 0) { particulas.splice(i, 1); continue; }
      ctx.globalAlpha = p.vida; ctx.fillStyle = p.cor; ctx.beginPath(); ctx.arc(p.x, p.y, p.tam, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1;
    if (passou < duracao + 4000 || particulas.length) requestAnimationFrame(quadro);
  }
  requestAnimationFrame(quadro);
  return () => { vivo = false; removeEventListener('resize', ajustar); };
}

// ---------- tela ----------
let aberta = null;
export function comemorar({ oficial, versao = 'dev' }) {
  // TSE confirmou com a festa do cálculo ainda na tela: atualiza a faixa em vez de abrir outra.
  if (aberta) { if (oficial) aberta.querySelector('.festa-faixa').textContent = 'ELEITO · CONFIRMADO PELO TSE'; return; }
  const el = document.createElement('div');
  el.className = 'festa';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-label', 'Flávio Bolsonaro eleito presidente');
  el.innerHTML = `
    <canvas class="festa-ceu" aria-hidden="true"></canvas>
    <div class="festa-conteudo">
      <div class="festa-faixa">${oficial ? 'ELEITO · CONFIRMADO PELO TSE' : 'MATEMATICAMENTE ELEITO'}</div>
      <div class="festa-halo"><img class="festa-foto" src="img/22.webp?v=${versao}" alt="Flávio Bolsonaro"></div>
      <div class="festa-nome">FLÁVIO BOLSONARO</div>
      <div class="festa-grito">FORA PT!</div>
      <div class="festa-botoes">
        <button type="button" class="festa-som" hidden>🔊 Ligar o som</button>
        <button type="button" class="festa-fechar">Fechar</button>
      </div>
    </div>`;
  document.body.appendChild(el);
  document.body.classList.add('festa-aberta');
  aberta = el;

  const duracao = reduzMovimento() ? 0 : 16000;
  const parar = duracao ? fogos(el.querySelector('.festa-ceu'), duracao) : () => {};
  const tocar = () => { fanfarra(); for (let i = 0; i < 6; i++) estouro(0.3 + i * 0.35, 0.9); gritoDeGuerra(2600); };
  vibrar([300, 120, 300, 120, 600, 200, 900]);
  if (somLiberado()) tocar();
  else {
    // Sem toque prévio o navegador bloqueia o som: um botão grande resolve com um toque.
    const b = el.querySelector('.festa-som');
    b.hidden = false;
    b.onclick = () => { destravarAudio(); setTimeout(() => { tocar(); vibrar([200, 100, 400]); }, 60); b.hidden = true; };
  }
  const fechar = () => { parar(); try { window.speechSynthesis?.cancel(); } catch { /* sem voz */ } el.remove(); document.body.classList.remove('festa-aberta'); aberta = null; };
  el.querySelector('.festa-fechar').onclick = fechar;
  document.addEventListener('keydown', function esc(ev) { if (ev.key === 'Escape') { fechar(); document.removeEventListener('keydown', esc); } });
  // Título da aba pisca para quem está em outra aba.
  const tituloOriginal = document.title;
  let n = 0;
  const pisca = setInterval(() => { document.title = n++ % 2 ? tituloOriginal : '🎆 FLÁVIO ELEITO!'; if (n > 30 || !aberta) { clearInterval(pisca); document.title = tituloOriginal; } }, 1000);
}
