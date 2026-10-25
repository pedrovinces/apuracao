// Métricas de audiência com o Umami Cloud: sem cookies (dispensa aviso de consentimento)
// e sem guardar dados pessoais. O ID do site é público; não é senha.
const UMAMI_ID = '';
const DOMINIO = 'apuracao.pedrovinces.com.br';

// Marcos de tempo com a página VISÍVEL. Intervalos de até 30 min entre marcos, porque o
// Umami encerra a visita após 30 min sem eventos; assim a duração da visita fica correta.
const MARCOS = [1, 3, 5, 10, 15, 20, 30, 45, 60, 75, 90, 105, 120, 150, 180, 210, 240];

const ativo = () => !!UMAMI_ID && location.hostname === DOMINIO; // testes e localhost não contam

export function evento(nome, dados) {
  if (!ativo()) return;
  try { window.umami?.track(nome, dados); } catch { /* métrica nunca quebra o painel */ }
}

export function iniciarMetricas() {
  if (!ativo()) return;
  const s = document.createElement('script');
  s.defer = true;
  s.src = 'https://cloud.umami.is/script.js';
  s.dataset.websiteId = UMAMI_ID;
  s.dataset.domains = DOMINIO;
  document.head.appendChild(s);

  // Tempo visível acumulado: aba em segundo plano ou tela apagada não conta.
  let acumulado = 0, desde = document.hidden ? null : Date.now(), proximo = 0;
  const total = () => acumulado + (desde ? Date.now() - desde : 0);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { acumulado = total(); desde = null; } else desde = Date.now();
  });
  setInterval(() => {
    const min = total() / 60000;
    while (proximo < MARCOS.length && min >= MARCOS[proximo]) {
      evento('assistiu', { minutos: MARCOS[proximo] });
      proximo++;
    }
  }, 10000);
}
