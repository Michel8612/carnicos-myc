// ============================================================
//  CENTRO DE AVISOS — pantalla completa
//
//  La campanita (js/avisos.js) es para un vistazo rápido; esta pantalla
//  es para revisar con calma: filtrar, ver el histórico y marcar como
//  leído. La abre gente de TODOS los roles (un almacenero también
//  recibe avisos de stock bajo), así que a diferencia de casi toda
//  otra pantalla del sistema, aquí NO se restringe por rol.
// ============================================================

// NOTA: no se usa "return" a este nivel (sería un SyntaxError: este
// archivo es un script clásico, no un módulo). Igual que en el resto de
// páginas guardadas (ver tablero.js, contabilidad.js...), lanzar corta
// la ejecución del script en seco.
if (!requiereSesion()) { throw new Error('sin acceso'); }

// El "← Panel" de esta pantalla no puede ir siempre a admin.html: la
// abre gente de todos los roles, y a un cocinero o un vendedor
// mandarlo al panel del dueño lo dejaría fuera (soloDuenoPagina lo
// redirigiría de vuelta a SU área). Por eso usa homeDeRol.
document.getElementById('navPanel').href = homeDeRol((getUsuario() || {}).rol);

// ---------- Estado en memoria ----------
let TODOS = [];         // última lista que trajo el servidor
let filtroEstado = 'todos'; // 'todos' | 'sinleer'
let filtroTipo = '';        // '' = todos los tipos

const $lista = document.getElementById('listaAvisos');
const $bTodos = document.getElementById('bTodos');
const $bSinLeer = document.getElementById('bSinLeer');
const $selTipo = document.getElementById('selTipo');
const $bMarcarTodas = document.getElementById('bMarcarTodas');

// Nombre legible para un tipo técnico ("stock_bajo" -> "Stock bajo").
// No hay catálogo cerrado de tipos (cualquier módulo puede crear uno
// nuevo con crearNotificacion()), así que se deriva del texto en vez
// de mantener una lista aparte que se desactualizaría.
function etiquetaTipo(tipo) {
  const limpio = String(tipo || '').replace(/_/g, ' ');
  return limpio.charAt(0).toUpperCase() + limpio.slice(1);
}

// "hace 5 minutos" / "hace 2 horas" / "ayer" / fecha completa si pasa
// de una semana (a partir de ahí el relativo deja de ser útil: "hace
// 19 días" dice menos que "14/07/2026").
function tiempoRelativo(fechaIso) {
  const fecha = new Date(fechaIso);
  const ahora = new Date();
  const minutos = Math.floor((ahora - fecha) / 60000);

  if (minutos < 1) return 'justo ahora';
  if (minutos < 60) return `hace ${minutos} minuto${minutos === 1 ? '' : 's'}`;
  const horas = Math.floor(minutos / 60);
  if (horas < 24) return `hace ${horas} hora${horas === 1 ? '' : 's'}`;

  // Días de CALENDARIO (no bloques de 24h): las 11pm de ayer son "ayer",
  // aunque falten pocas horas para cumplir el día completo.
  const inicioHoy = new Date(ahora.getFullYear(), ahora.getMonth(), ahora.getDate());
  const inicioFecha = new Date(fecha.getFullYear(), fecha.getMonth(), fecha.getDate());
  const dias = Math.round((inicioHoy - inicioFecha) / 86400000);
  if (dias <= 0) return 'hoy';
  if (dias === 1) return 'ayer';
  if (dias < 7) return `hace ${dias} días`;

  return fecha.toLocaleString('es-CU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

const esc = (t) => String(t ?? '').replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));

// ---------- Construir el desplegable de tipos a partir de lo que llegó ----------
function actualizarTipos() {
  const tipos = [...new Set(TODOS.map((a) => a.tipo))].sort();
  const actual = $selTipo.value;
  $selTipo.innerHTML = '<option value="">Todos los tipos</option>' +
    tipos.map((t) => `<option value="${esc(t)}">${esc(etiquetaTipo(t))}</option>`).join('');
  // Conservar la selección si el tipo elegido sigue existiendo entre los avisos.
  if (tipos.includes(actual)) $selTipo.value = actual;
}

// ---------- Pintar la lista según los filtros activos ----------
function pintar() {
  let filas = TODOS;
  if (filtroEstado === 'sinleer') filas = filas.filter((a) => !a.leida);
  if (filtroTipo) filas = filas.filter((a) => a.tipo === filtroTipo);

  if (!filas.length) {
    const razon = TODOS.length ? 'No hay avisos con este filtro.' : 'No hay avisos por ahora.';
    $lista.innerHTML = `<p class="vacio">${razon}</p>`;
    return;
  }

  $lista.innerHTML = filas.map((a) => `
    <div class="aviso-fila sev-${esc(a.severidad)} ${a.leida ? '' : 'no-leido'}" data-id="${a.id}">
      <div class="aviso-cab">
        <span class="aviso-titulo">${esc(a.titulo)}</span>
        ${a.leida ? '' : '<span class="marca-nueva">Sin leer</span>'}
      </div>
      ${a.mensaje ? `<p class="aviso-mensaje">${esc(a.mensaje)}</p>` : ''}
      <div class="aviso-meta">
        <span class="etq-tipo">${esc(etiquetaTipo(a.tipo))}</span>
        <span>${tiempoRelativo(a.creada_en)}</span>
      </div>
      ${a.leida ? '' : '<div class="aviso-acciones"><button type="button" class="btn-leida">Marcar como leída</button></div>'}
    </div>
  `).join('');
}

// ---------- Cargar del servidor ----------
async function cargar() {
  try {
    TODOS = await API.avisos();
    actualizarTipos();
    pintar();
  } catch (e) {
    $lista.innerHTML = `<p class="vacio">${esc(e.message)}</p>`;
  }
}

// ---------- Escuchadores ----------
$bTodos.addEventListener('click', () => {
  filtroEstado = 'todos';
  $bTodos.classList.add('activo');
  $bSinLeer.classList.remove('activo');
  pintar();
});
$bSinLeer.addEventListener('click', () => {
  filtroEstado = 'sinleer';
  $bSinLeer.classList.add('activo');
  $bTodos.classList.remove('activo');
  pintar();
});
$selTipo.addEventListener('change', () => {
  filtroTipo = $selTipo.value;
  pintar();
});

// Un solo escuchador para toda la lista (se redibuja entera en cada
// cambio de filtro, así que enganchar botón por botón dejaría
// escuchadores viejos colgando de nodos que ya no existen).
$lista.addEventListener('click', async (ev) => {
  const boton = ev.target.closest('.btn-leida');
  if (!boton) return;
  const fila = boton.closest('.aviso-fila');
  const id = fila.dataset.id;

  boton.disabled = true;
  try {
    await API.avisoLeido(id);
    const aviso = TODOS.find((a) => String(a.id) === String(id));
    if (aviso) aviso.leida = true;
    pintar();
  } catch (e) {
    alert(e.message);
    boton.disabled = false;
  }
});

$bMarcarTodas.addEventListener('click', async () => {
  if (!TODOS.some((a) => !a.leida)) return; // nada que marcar
  if (!confirm('¿Marcar todos los avisos como leídos?')) return;

  $bMarcarTodas.disabled = true;
  try {
    await API.avisosLeerTodas();
    TODOS = TODOS.map((a) => ({ ...a, leida: true }));
    pintar();
  } catch (e) {
    alert(e.message);
  } finally {
    $bMarcarTodas.disabled = false;
  }
});

cargar();
