// ============================================================
//  Copias de seguridad — Cárnicos M&C
//
//  Solo dueño/admin/proveedor (igual que decide el backend).
//
//  Por qué esta pantalla no usa API.* de js/api.js: apiFetch()
//  siempre hace res.json(), y la descarga del respaldo necesita el
//  archivo crudo (blob) con las cabeceras de descarga puestas por el
//  servidor, no un JSON ya interpretado. Se repite aquí una versión
//  mínima de esa misma lógica (mismo token, mismo manejo de 401),
//  sin tocar js/api.js.
// ============================================================

if (!soloDuenoPagina()) { throw new Error('sin acceso'); }

if (esDueno()) {
  const nav = document.getElementById('navPanel');
  nav.style.display = ''; nav.href = 'admin.html';
}

const RESPALDOS_BASE =
  location.port === '5173'
    ? `${location.protocol}//${location.hostname}:3001/api/respaldos`
    : '/api/respaldos';

function tokenSesion() { return localStorage.getItem('carnicos_token'); }

// Petición JSON normal (historial, restaurar). La descarga (exportar)
// se maneja aparte más abajo porque necesita el archivo crudo.
async function llamarRespaldos(ruta, opciones = {}) {
  const token = tokenSesion();
  let res;
  try {
    res = await fetch(RESPALDOS_BASE + ruta, {
      ...opciones,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
        ...(opciones.headers || {}),
      },
    });
  } catch (e) {
    throw new Error('No hay conexión con el servidor.');
  }
  const datos = await res.json().catch(() => ({}));
  if (res.status === 401) {
    location.href = 'index.html';
    throw new Error(datos.error || 'Su sesión expiró.');
  }
  if (!res.ok) throw new Error(datos.error || 'Algo salió mal. Intente de nuevo.');
  return datos;
}

const esc = (t) => String(t ?? '').replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));

const fechaHora = (f) => {
  if (!f) return '';
  const d = new Date(f);
  return d.toLocaleDateString('es-CU', { day: '2-digit', month: '2-digit', year: 'numeric' }) +
    ' ' + d.toLocaleTimeString('es-CU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
};

const ETIQUETA_TIPO = { exportar: 'Descarga', restaurar: 'Restauración' };

// ------------------------------------------------------------
//  Descargar copia de seguridad
// ------------------------------------------------------------
const btnDescargar = document.getElementById('btnDescargar');
const estadoDescarga = document.getElementById('estadoDescarga');

btnDescargar.addEventListener('click', async () => {
  btnDescargar.disabled = true;
  estadoDescarga.textContent = 'Generando el respaldo, un momento…';
  try {
    const token = tokenSesion();
    const res = await fetch(RESPALDOS_BASE + '/exportar', {
      headers: token ? { Authorization: 'Bearer ' + token } : {},
    });
    if (res.status === 401) {
      location.href = 'index.html';
      return;
    }
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'No se pudo generar el respaldo.');
    }
    const blob = await res.blob();

    // Nombre de archivo: se toma de la cabecera que manda el
    // servidor; si por algo no viene, se arma uno de respaldo aquí.
    const cabecera = res.headers.get('Content-Disposition') || '';
    const coincide = /filename="?([^"]+)"?/.exec(cabecera);
    const nombre = coincide ? coincide[1] : `respaldo-carnicos-${new Date().toISOString().slice(0, 10)}.json`;

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = nombre;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);

    estadoDescarga.textContent = 'Listo: revise su carpeta de descargas.';
    cargarHistorial();
  } catch (e) {
    estadoDescarga.textContent = 'Error: ' + e.message;
  } finally {
    btnDescargar.disabled = false;
  }
});

// ------------------------------------------------------------
//  Restaurar (zona roja)
// ------------------------------------------------------------
const archRestaurar = document.getElementById('archRestaurar');
const confRestaurar = document.getElementById('confRestaurar');
const btnRestaurar = document.getElementById('btnRestaurar');
const estadoRestaurar = document.getElementById('estadoRestaurar');

// El botón se queda bloqueado hasta que haya un archivo elegido Y la
// palabra exacta escrita a mano: dos confirmaciones para algo que no
// se puede deshacer.
function actualizarBotonRestaurar() {
  btnRestaurar.disabled = !(archRestaurar.files.length && confRestaurar.value === 'RESTAURAR');
}
archRestaurar.addEventListener('change', actualizarBotonRestaurar);
confRestaurar.addEventListener('input', actualizarBotonRestaurar);
actualizarBotonRestaurar();

function leerArchivoComoJson(archivo) {
  return new Promise((resolve, reject) => {
    const lector = new FileReader();
    lector.onload = () => {
      try { resolve(JSON.parse(lector.result)); }
      catch { reject(new Error('El archivo elegido no es un JSON válido.')); }
    };
    lector.onerror = () => reject(new Error('No se pudo leer el archivo.'));
    lector.readAsText(archivo);
  });
}

btnRestaurar.addEventListener('click', async () => {
  if (!archRestaurar.files.length) return;

  // Tercera confirmación (además del archivo y la palabra escrita):
  // un diálogo nativo, para que no se dispare por un doble clic.
  const confirmado = confirm(
    'Esto va a BORRAR todos los datos actuales y reemplazarlos por los del archivo elegido. ' +
    'No se puede deshacer. ¿Continuar?'
  );
  if (!confirmado) return;

  btnRestaurar.disabled = true;
  estadoRestaurar.textContent = 'Restaurando… no cierre esta página.';
  try {
    const datos = await leerArchivoComoJson(archRestaurar.files[0]);
    const r = await llamarRespaldos('/restaurar', {
      method: 'POST',
      body: JSON.stringify({ confirmar: 'RESTAURAR', datos }),
    });
    estadoRestaurar.textContent = `Listo: ${r.tablas} tablas y ${r.filas} filas restauradas.`;
    archRestaurar.value = '';
    confRestaurar.value = '';
    cargarHistorial();
  } catch (e) {
    estadoRestaurar.textContent = 'Error: ' + e.message;
  } finally {
    actualizarBotonRestaurar();
  }
});

// ------------------------------------------------------------
//  Historial
// ------------------------------------------------------------
async function cargarHistorial() {
  const tbody = document.getElementById('tbHistorial');
  tbody.innerHTML = '<tr><td colspan="7" class="vacio">Cargando…</td></tr>';
  try {
    const filas = await llamarRespaldos('');
    if (!filas.length) {
      tbody.innerHTML = '<tr><td colspan="7" class="vacio">Todavía no hay copias registradas.</td></tr>';
      return;
    }
    tbody.innerHTML = filas.map((f) => `
      <tr>
        <td>${fechaHora(f.creado_en)}</td>
        <td>${esc(ETIQUETA_TIPO[f.tipo] || f.tipo)}</td>
        <td class="izq">${esc(f.usuario_nombre) || '<i>—</i>'}</td>
        <td>${f.tablas ?? ''}</td>
        <td>${f.filas ?? ''}</td>
        <td><span class="etq ${f.resultado === 'ok' ? 'e-activa' : 'e-anulado'}">${esc(f.resultado)}</span></td>
        <td class="izq">${esc(f.detalle) || ''}</td>
      </tr>
    `).join('');
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="7" class="vacio">Error al cargar: ${esc(e.message)}</td></tr>`;
  }
}

cargarHistorial();
