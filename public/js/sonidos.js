// ============================================================
//  Sonidos de la aplicación — Cárnicos M&C
//
//  Pequeños pitidos para que el trabajo se sienta más vivo: uno
//  al pulsar un botón, otro al guardar bien, otro al borrar y
//  otro si algo sale mal.
//
//  Los sonidos se generan solos (no se descarga ningún archivo),
//  así que no cargan la conexión ni pueden romper nada: si el
//  navegador no lo permite, sencillamente no suena y la app sigue
//  funcionando igual. El usuario puede apagarlos desde el icono
//  de la esquina; su decisión se recuerda.
// ============================================================

(function () {
  'use strict';

  const CLAVE = 'carnicos_sonido';
  let contexto = null;

  const activado = () => localStorage.getItem(CLAVE) !== 'off';

  // El navegador solo deja crear sonido después de que la persona
  // toque la pantalla, por eso se crea al primer uso.
  function obtenerContexto() {
    try {
      if (!contexto) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return null;
        contexto = new AC();
      }
      if (contexto.state === 'suspended') contexto.resume();
      return contexto;
    } catch (e) {
      return null;
    }
  }

  // Un tono corto y suave.
  function tono(frecuencia, duracion, volumen, forma) {
    try {
      if (!activado()) return;
      const ctx = obtenerContexto();
      if (!ctx) return;
      const osc = ctx.createOscillator();
      const gan = ctx.createGain();
      osc.type = forma || 'sine';
      osc.frequency.value = frecuencia;
      // Entra y sale suave: así no suena a "clic" molesto.
      gan.gain.setValueAtTime(0, ctx.currentTime);
      gan.gain.linearRampToValueAtTime(volumen, ctx.currentTime + 0.012);
      gan.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + duracion);
      osc.connect(gan).connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + duracion + 0.02);
    } catch (e) {
      /* si el navegador no deja, no pasa nada */
    }
  }

  const Sonido = {
    // Toque normal de un botón.
    clic() { tono(440, 0.07, 0.05, 'triangle'); },
    // Algo se guardó bien (dos notas que suben).
    exito() { tono(660, 0.09, 0.06, 'sine'); setTimeout(() => tono(880, 0.13, 0.06, 'sine'), 90); },
    // Se borró algo (dos notas que bajan).
    borrar() { tono(400, 0.08, 0.05, 'triangle'); setTimeout(() => tono(260, 0.14, 0.05, 'triangle'), 80); },
    // Algo salió mal.
    error() { tono(200, 0.22, 0.07, 'square'); },
    // Aviso suave.
    aviso() { tono(560, 0.1, 0.05, 'sine'); },
    activado,
    alternar() {
      const nuevo = activado() ? 'off' : 'on';
      localStorage.setItem(CLAVE, nuevo);
      if (nuevo === 'on') Sonido.exito();
      return nuevo === 'on';
    },
  };

  window.Sonido = Sonido;

  // --- Sonido automático en los botones ---
  // Se escucha el clic en toda la página: cualquier botón o enlace de
  // acción suena solo, sin tener que tocar cada pantalla. El tipo de
  // sonido se elige por lo que hace el botón (guardar, borrar…).
  document.addEventListener('click', (e) => {
    const el = e.target.closest('button, .croquis-tarjeta, .top-nav a');
    if (!el || el.disabled) return;

    const texto = (el.textContent || '').toLowerCase();
    const clases = el.className || '';

    if (/elimin|borrar|quitar|×|✕/.test(texto) || /btn-x|btn-elimin|b-borrar/.test(clases)) {
      Sonido.borrar();
    } else if (/guardar|crear|agregar|registrar|producir|entrada|vender|activar/.test(texto)) {
      Sonido.exito();
    } else {
      Sonido.clic();
    }
  }, true);

  // --- Interruptor para apagar o encender los sonidos ---
  document.addEventListener('DOMContentLoaded', () => {
    try {
      const boton = document.createElement('button');
      boton.type = 'button';
      boton.id = 'btnSonido';
      boton.title = 'Encender o apagar los sonidos';
      boton.textContent = activado() ? '🔊' : '🔇';
      boton.style.cssText = [
        'position:fixed', 'right:14px', 'bottom:14px', 'z-index:200',
        'width:44px', 'height:44px', 'border-radius:50%', 'border:none',
        'background:#37474f', 'color:#fff', 'font-size:19px', 'cursor:pointer',
        'box-shadow:0 3px 10px rgba(0,0,0,.3)', 'opacity:.85',
      ].join(';');
      boton.addEventListener('click', (e) => {
        e.stopPropagation();
        boton.textContent = Sonido.alternar() ? '🔊' : '🔇';
      });
      document.body.appendChild(boton);
    } catch (e) {
      /* si algo falla, la app sigue igual */
    }
  });
})();
