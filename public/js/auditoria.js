// ============================================================
//  Auditoría — Cárnicos M&C
//
//  Pantalla de solo lectura sobre la tabla `auditoria`: quién hizo
//  qué y cuándo. Solo entran dueño/admin/proveedor y contabilidad
//  (igual que decide el backend; aquí es solo para no mostrar un
//  botón que de todas formas el servidor va a rechazar).
// ============================================================

if (!soloRoles(['contabilidad'])) { throw new Error('sin acceso'); }

if (esDueno()) {
  const nav = document.getElementById('navPanel');
  nav.style.display = ''; nav.href = 'admin.html';
}

const esc = (t) => String(t ?? '').replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));

const fechaHora = (f) => {
  if (!f) return '';
  const d = new Date(f);
  return d.toLocaleDateString('es-CU', { day: '2-digit', month: '2-digit', year: 'numeric' }) +
    ' ' + d.toLocaleTimeString('es-CU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
};

// Etiquetas legibles para las acciones más comunes; lo que no se
// reconozca se muestra tal cual (el módulo de auditoría admite texto
// libre a propósito, para no obligar a migrar si aparece una acción nueva).
const ETIQUETA_ACCION = {
  login: 'Ingreso', login_fallido: 'Ingreso fallido', logout: 'Salida',
  crear: 'Creación', modificar: 'Modificación', eliminar: 'Eliminación',
  autorizar: 'Autorización', aceptar: 'Aceptación', cancelar: 'Cancelación', exportar: 'Exportación',
};
const claseAccion = (a) => 'e-' + (['login', 'login_fallido', 'logout', 'crear', 'modificar', 'eliminar', 'autorizar'].includes(a) ? a : 'otra');
const etiquetaAccion = (a) => ETIQUETA_ACCION[a] || a || '';

// Un valor guardado por auditar() puede ser texto/número tal cual o un
// JSON (cuando se auditó un objeto). Se intenta parsear; si no es JSON,
// se muestra el texto plano.
function valorLegible(v) {
  if (v === null || v === undefined || v === '') return null;
  try {
    const obj = JSON.parse(v);
    if (obj && typeof obj === 'object') {
      return Object.entries(obj)
        .map(([k, val]) => `${esc(k)}: ${esc(typeof val === 'object' ? JSON.stringify(val) : val)}`)
        .join('<br>');
    }
    return esc(String(obj));
  } catch {
    return esc(v);
  }
}

function celdaCambio(fila) {
  const antes = valorLegible(fila.valor_anterior);
  const despues = valorLegible(fila.valor_nuevo);
  if (!antes && !despues) return '';
  let html = '<div class="valores-cambio">';
  if (antes) html += `<div class="antes">− ${antes}</div>`;
  if (despues) html += `<div class="despues">+ ${despues}</div>`;
  html += '</div>';
  return html;
}

async function cargarFiltros() {
  try {
    const f = await API.auditoriaFiltros();
    const selUsuario = document.getElementById('fUsuario');
    const selModulo = document.getElementById('fModulo');
    const selAccion = document.getElementById('fAccion');

    for (const u of f.usuarios || []) {
      if (u.id == null) continue;
      const op = document.createElement('option');
      op.value = u.id; op.textContent = u.nombre || `#${u.id}`;
      selUsuario.appendChild(op);
    }
    for (const m of f.modulos || []) {
      const op = document.createElement('option');
      op.value = m; op.textContent = m;
      selModulo.appendChild(op);
    }
    for (const a of f.acciones || []) {
      const op = document.createElement('option');
      op.value = a; op.textContent = etiquetaAccion(a);
      selAccion.appendChild(op);
    }
  } catch (e) {
    // Si fallan los filtros, la tabla igual se puede consultar sin ellos.
    console.error('No se pudieron cargar los filtros de auditoría:', e.message);
  }
}

function leerFiltros() {
  const f = {};
  const usuario_id = document.getElementById('fUsuario').value;
  const modulo = document.getElementById('fModulo').value;
  const accion = document.getElementById('fAccion').value;
  const desde = document.getElementById('fDesde').value;
  const hasta = document.getElementById('fHasta').value;
  const limite = document.getElementById('fLimite').value;
  if (usuario_id) f.usuario_id = usuario_id;
  if (modulo) f.modulo = modulo;
  if (accion) f.accion = accion;
  if (desde) f.desde = desde;
  if (hasta) f.hasta = hasta;
  if (limite) f.limite = limite;
  return f;
}

async function cargarAuditoria() {
  const tbody = document.getElementById('tbAuditoria');
  tbody.innerHTML = '<tr><td colspan="10" class="vacio">Cargando…</td></tr>';
  try {
    const { filas, total } = await API.auditoria(leerFiltros());
    document.getElementById('kTotal').textContent = total;
    document.getElementById('kMostrados').textContent = filas.length;

    if (!filas.length) {
      tbody.innerHTML = '<tr><td colspan="10" class="vacio">No hay registros con ese filtro.</td></tr>';
      return;
    }

    tbody.innerHTML = filas.map((f) => `
      <tr>
        <td>${fechaHora(f.fecha)}</td>
        <td class="izq">${esc(f.usuario_nombre) || '<i>—</i>'}</td>
        <td>${esc(f.rol) || ''}</td>
        <td>${esc(f.modulo)}</td>
        <td><span class="etq ${claseAccion(f.accion)}">${esc(etiquetaAccion(f.accion))}</span></td>
        <td class="izq">${esc(f.entidad) || ''}${f.entidad_id ? ' #' + esc(f.entidad_id) : ''}</td>
        <td class="izq">${esc(f.descripcion) || ''}</td>
        <td class="izq">${celdaCambio(f)}</td>
        <td class="izq">${esc(f.motivo) || ''}</td>
        <td class="izq">${esc(f.autorizado_nombre) || ''}</td>
      </tr>
    `).join('');
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="10" class="vacio">Error al cargar: ${esc(e.message)}</td></tr>`;
  }
}

document.getElementById('btnFiltrar').addEventListener('click', cargarAuditoria);
document.getElementById('btnLimpiar').addEventListener('click', () => {
  document.getElementById('fUsuario').value = '';
  document.getElementById('fModulo').value = '';
  document.getElementById('fAccion').value = '';
  document.getElementById('fDesde').value = '';
  document.getElementById('fHasta').value = '';
  document.getElementById('fLimite').value = '200';
  cargarAuditoria();
});

cargarFiltros();
cargarAuditoria();
