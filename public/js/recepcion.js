// ============================================================
//  BANDEJA DE RECEPCIÓN — compartida por Almacén y Ventas
//
//  Lo que llega en camino y todavía no se ha aceptado. La mercancía
//  enviada NO entra sola: queda "pendiente" hasta que el destinatario
//  la acepta, y solo entonces se le suma. Así, si el paquete no llegó,
//  las cuentas no dicen que sí.
//
//  Esto vivía dentro de js/almacen.js y por eso solo lo tenía el
//  almacenero: al vendedor le mandaban mercancía y no tenía dónde
//  verla ni cómo aceptarla, así que nunca la recibía. Está aquí fuera
//  para que las dos pantallas usen EL MISMO código y no dos copias que
//  se vayan separando con el tiempo.
//
//  Para usarlo hacen falta tres cosas en la página:
//    · <link rel="stylesheet" href="css/recepcion.css">
//    · <script src="js/recepcion.js"></script>  ANTES del js de la página
//    · los tres ids del marcado: avisoPendientes, bandejaRecepcion,
//      bandejaLista
//  y llamar a cargarBandejaRecepcion(alRefrescar) al cargar la pantalla.
//
//  El servidor ya decide QUÉ le toca a cada quien
//  (GET /inventario/transferencias/pendientes filtra por almacén si es
//  almacenero y por usuario si es vendedor), y también quién puede
//  aceptar. Aquí no se filtra nada: sería adivinar por segunda vez.
// ============================================================

// Qué volver a cargar después de aceptar o cancelar. Cada pantalla
// tiene lo suyo (el almacén recarga existencias y selects; ventas, su
// inventario), así que lo pone quien llama. Se guarda en una variable
// del módulo porque los botones se pintan con onclick en línea y
// resolverTransferencia tiene que seguir siendo global.
let alRefrescarBandeja = null;

function fechaCorta(f) {
  if (!f) return '';
  const d = new Date(f);
  return d.toLocaleDateString('es-CU', { day: '2-digit', month: '2-digit' }) + ' ' +
    d.toLocaleTimeString('es-CU', { hour: '2-digit', minute: '2-digit' });
}

async function cargarBandejaRecepcion(alRefrescar) {
  if (typeof alRefrescar === 'function') alRefrescarBandeja = alRefrescar;

  const aviso = document.getElementById('avisoPendientes');
  const bloque = document.getElementById('bandejaRecepcion');
  const lista = document.getElementById('bandejaLista');
  // Opcional: el texto de "no hay nada esperando". Ventas lo tiene
  // porque allí la bandeja es una pestaña entera y quedaría en blanco;
  // en Almacén la bandeja solo asoma cuando hay algo, y no hace falta.
  const vacio = document.getElementById('recepcionVacio');
  if (!bloque || !lista) return;

  let pendientes = [];
  try { pendientes = await API.transferenciasPendientes(); } catch (e) { pendientes = []; }

  if (!pendientes.length) {
    bloque.classList.add('hidden');
    if (aviso) aviso.classList.add('hidden');
    if (vacio) vacio.classList.remove('hidden');
    return;
  }

  if (aviso) {
    aviso.classList.remove('hidden');
    aviso.textContent = pendientes.length === 1
      ? 'Tiene 1 entrada por recibir'
      : `Tiene ${pendientes.length} entradas por recibir`;
  }
  if (vacio) vacio.classList.add('hidden');

  bloque.classList.remove('hidden');
  lista.innerHTML = pendientes.map((t) => `
    <div class="tarjeta-pendiente">
      <div class="tarjeta-pendiente-info">
        <b>${t.producto_nombre || 'Producto'}</b>
        — ${Number(t.cantidad).toLocaleString('es-CU', { maximumFractionDigits: 3 })}
        <br>
        <span class="tarjeta-pendiente-detalle">
          Envía: ${t.enviado_nombre || 'alguien'} · Desde: ${t.origen_almacen_nombre || '—'} · ${fechaCorta(t.fecha_envio)}
        </span>
      </div>
      <div class="tarjeta-pendiente-botones">
        <button class="btn-aceptar" onclick="resolverTransferencia(${t.id}, 'aceptar')">Aceptar entrada</button>
        <button class="btn-cancelar" onclick="resolverTransferencia(${t.id}, 'cancelar')">Cancelar recepción</button>
      </div>
    </div>
  `).join('');
}

async function resolverTransferencia(id, accion) {
  if (accion === 'cancelar' && !confirm('¿Cancelar esta recepción? La mercancía volverá al almacén de origen.')) return;
  try {
    if (accion === 'aceptar') await API.aceptarTransferencia(id);
    else await API.cancelarTransferencia(id);

    // El aviso de la campanita ya no tiene sentido: lo que avisaba
    // acaba de resolverse. Se baja el número en el momento en vez de
    // esperar los dos minutos del refresco automático, que al usuario
    // le parecería que el sistema no se enteró.
    if (typeof window.refrescarAvisos === 'function') window.refrescarAvisos();

    if (typeof alRefrescarBandeja === 'function') await alRefrescarBandeja();
    else await cargarBandejaRecepcion();
  } catch (e) {
    alert('No se pudo resolver la transferencia: ' + e.message);
  }
}
