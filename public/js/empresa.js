// ============================================================
//  Empresa — Cárnicos M&C
//
//  Configuración fiscal, cuentas bancarias, movimientos y estado
//  de las pasarelas de pago. Pantalla del dueño y de contabilidad
//  (contabilidad puede ver todo y mover cuentas/movimientos, pero
//  solo el dueño puede cambiar los datos fiscales: así lo exige el
//  backend en /api/empresa).
// ============================================================

if (!soloRoles(['contabilidad'])) { throw new Error('sin acceso'); }

const money = (n) => Number(n ?? 0).toLocaleString('es-CU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const esc = (t) => String(t ?? '').replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
const fechaHora = (f) => {
  if (!f) return '';
  const d = new Date(f);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('es-CU', { day: '2-digit', month: '2-digit', year: 'numeric' }) +
    ' ' + d.toLocaleTimeString('es-CU', { hour: '2-digit', minute: '2-digit' });
};
function sonar(fn) { try { Sonido[fn](); } catch { /* si no cargó el módulo de sonido, no pasa nada */ } }

if (esDueno()) {
  const nav = document.getElementById('navPanel');
  nav.style.display = ''; nav.href = 'admin.html';
}

// ---------- Pestañas ----------
document.querySelectorAll('.tabs button').forEach((b) => {
  b.addEventListener('click', () => {
    document.querySelectorAll('.tabs button').forEach((x) => x.classList.remove('activo'));
    document.querySelectorAll('.panel').forEach((p) => p.classList.remove('activo'));
    b.classList.add('activo');
    document.getElementById(b.dataset.panel).classList.add('activo');
    if (b.dataset.panel === 'pCuentas') cargarCuentas();
    if (b.dataset.panel === 'pMovimientos') cargarMovimientos();
    if (b.dataset.panel === 'pPasarelas') cargarPasarelas();
  });
});

// ============================================================
//  DATOS FISCALES
// ============================================================

// Solo el dueño puede guardar (el backend lo exige igual: esto es
// solo para no ofrecer un botón que va a fallar).
if (!esDueno()) {
  document.getElementById('fiscalSoloLectura').style.display = '';
  document.getElementById('btnGuardarFiscal').style.display = 'none';
  document.querySelectorAll('#pFiscal input, #pFiscal select').forEach((el) => { el.disabled = true; });
}

async function cargarFiscal() {
  let d;
  try { d = await API.empresa(); }
  catch (e) { alert('No se pudo cargar los datos fiscales: ' + e.message); return; }

  document.getElementById('fNombreFiscal').value = d.nombre_fiscal || '';
  document.getElementById('fRazonSocial').value = d.razon_social || '';
  document.getElementById('fNit').value = d.nit || '';
  document.getElementById('fRegimen').value = d.regimen_tributario || '';
  document.getElementById('fDireccion').value = d.direccion || '';
  document.getElementById('fProvincia').value = d.provincia || '';
  document.getElementById('fMunicipio').value = d.municipio || '';
  document.getElementById('fTelefono').value = d.telefono || '';
  document.getElementById('fCorreo').value = d.correo || '';
  document.getElementById('fMonedaPrincipal').value = d.moneda_principal || 'CUP';

  const secundarias = Array.isArray(d.monedas_secundarias) ? d.monedas_secundarias : [];
  document.querySelectorAll('.fMonedaSec').forEach((c) => { c.checked = secundarias.includes(c.value); });

  const fact = d.datos_facturacion || {};
  document.getElementById('fPieFactura').value = fact.pie_factura || '';
  document.getElementById('fPrefijoSerie').value = fact.prefijo_serie || '';

  const rep = d.datos_reportes || {};
  document.getElementById('fEncabezadoReportes').value = rep.encabezado_oficial || '';

  const info = document.getElementById('fiscalActualizado');
  info.textContent = d.actualizado_en ? `Última actualización: ${fechaHora(d.actualizado_en)}` : '';
}

document.getElementById('btnGuardarFiscal').addEventListener('click', async () => {
  const correo = document.getElementById('fCorreo').value.trim();
  const body = {
    nombre_fiscal: document.getElementById('fNombreFiscal').value.trim(),
    razon_social: document.getElementById('fRazonSocial').value.trim(),
    nit: document.getElementById('fNit').value.trim(),
    regimen_tributario: document.getElementById('fRegimen').value,
    direccion: document.getElementById('fDireccion').value.trim(),
    provincia: document.getElementById('fProvincia').value.trim(),
    municipio: document.getElementById('fMunicipio').value.trim(),
    telefono: document.getElementById('fTelefono').value.trim(),
    correo,
    moneda_principal: document.getElementById('fMonedaPrincipal').value,
    monedas_secundarias: Array.from(document.querySelectorAll('.fMonedaSec:checked')).map((c) => c.value),
    datos_facturacion: {
      pie_factura: document.getElementById('fPieFactura').value.trim(),
      prefijo_serie: document.getElementById('fPrefijoSerie').value.trim(),
    },
    datos_reportes: {
      encabezado_oficial: document.getElementById('fEncabezadoReportes').value.trim(),
    },
  };
  try {
    await API.guardarEmpresa(body);
    sonar('exito');
    await cargarFiscal();
    alert('Datos fiscales guardados.');
  } catch (e) {
    alert('No se pudo guardar: ' + e.message);
  }
});

// ============================================================
//  CUENTAS BANCARIAS
// ============================================================

let cuentasCache = [];

function actualizarPrevisualizacionQr() {
  const banco = document.getElementById('cBanco').value.trim() || '(banco)';
  const numero = document.getElementById('cNumero').value.trim();
  const alias = document.getElementById('cAlias').value.trim();
  const titular = document.getElementById('cTitular').value.trim();
  const moneda = document.getElementById('cMoneda').value;
  const partes = [
    `Banco: ${banco}`,
    alias ? `Alias de cobro: ${alias}` : `Cuenta: ${numero || '(número)'}`,
    `Moneda: ${moneda}`,
    titular ? `Titular: ${titular}` : null,
  ].filter(Boolean);
  document.getElementById('cQrTexto').textContent = partes.join('\n');
}
['cBanco', 'cNumero', 'cAlias', 'cTitular', 'cMoneda'].forEach((id) => {
  document.getElementById(id).addEventListener('input', actualizarPrevisualizacionQr);
  document.getElementById(id).addEventListener('change', actualizarPrevisualizacionQr);
});
actualizarPrevisualizacionQr();

// La imagen del QR no se genera aquí (no se improvisa un algoritmo de
// codificación QR): si el usuario ya tiene la imagen (generada con la
// app de su banco a partir del texto de arriba), simplemente se lee
// como archivo local y se guarda como data URL junto a la cuenta.
let qrImagenActual = null;
document.getElementById('cQrArchivo').addEventListener('change', (e) => {
  const archivo = e.target.files[0];
  if (!archivo) { qrImagenActual = null; return; }
  const lector = new FileReader();
  lector.onload = () => {
    qrImagenActual = lector.result;
    const prev = document.getElementById('cQrPreview');
    prev.src = qrImagenActual;
    prev.style.display = '';
  };
  lector.readAsDataURL(archivo);
});

function limpiarFormCuenta() {
  document.getElementById('cId').value = '';
  document.getElementById('cBanco').value = '';
  document.getElementById('cNumero').value = '';
  document.getElementById('cAlias').value = '';
  document.getElementById('cTitular').value = '';
  document.getElementById('cMoneda').value = 'CUP';
  document.getElementById('cEstado').value = 'activa';
  document.querySelectorAll('.cUsarEn').forEach((c) => { c.checked = false; });
  qrImagenActual = null;
  document.getElementById('cQrArchivo').value = '';
  document.getElementById('cQrPreview').style.display = 'none';
  document.getElementById('btnCancelarCuenta').style.display = 'none';
  document.getElementById('btnGuardarCuenta').textContent = 'Guardar cuenta';
  actualizarPrevisualizacionQr();
}

document.getElementById('btnCancelarCuenta').addEventListener('click', limpiarFormCuenta);

async function cargarCuentas() {
  try { cuentasCache = await API.cuentasBancarias(); }
  catch (e) { alert('No se pudo cargar las cuentas: ' + e.message); return; }

  const tb = document.getElementById('tbCuentas');
  tb.innerHTML = cuentasCache.length ? cuentasCache.map((c) => `
    <tr>
      <td class="izq"><b>${esc(c.banco)}</b></td>
      <td class="izq">${esc(c.numero)}</td>
      <td class="izq">${esc(c.alias || '—')}</td>
      <td class="izq">${esc(c.titular || '—')}</td>
      <td>${esc(c.moneda)}</td>
      <td><span class="etq e-${c.estado}">${c.estado === 'activa' ? 'Activa' : 'Inactiva'}</span></td>
      <td class="izq">${(c.usar_en || []).map((u) => `<span class="etq e-registrado">${esc(u)}</span>`).join(' ') || '—'}</td>
      <td>
        <button class="btn-x" style="background:#607d8b" onclick="editarCuenta(${c.id})">Editar</button>
        <button class="btn-x" onclick="borrarCuenta(${c.id})">Borrar</button>
      </td>
    </tr>`).join('') : '<tr><td colspan="8" class="vacio">No hay cuentas bancarias registradas.</td></tr>';

  llenarSelectCuentas();
}

function llenarSelectCuentas() {
  const opciones = cuentasCache.map((c) => `<option value="${c.id}">${esc(c.banco)} — ${esc(c.alias || c.numero)} (${esc(c.moneda)})</option>`).join('');
  document.getElementById('mCuenta').innerHTML = opciones || '<option value="">No hay cuentas</option>';
  document.getElementById('fmCuenta').innerHTML = '<option value="">Todas</option>' + opciones;
}

window.editarCuenta = function editarCuenta(id) {
  const c = cuentasCache.find((x) => x.id === id);
  if (!c) return;
  document.getElementById('cId').value = c.id;
  document.getElementById('cBanco').value = c.banco || '';
  document.getElementById('cNumero').value = c.numero || '';
  document.getElementById('cAlias').value = c.alias || '';
  document.getElementById('cTitular').value = c.titular || '';
  document.getElementById('cMoneda').value = c.moneda || 'CUP';
  document.getElementById('cEstado').value = c.estado || 'activa';
  document.querySelectorAll('.cUsarEn').forEach((chk) => { chk.checked = (c.usar_en || []).includes(chk.value); });
  qrImagenActual = c.qr_imagen || null;
  const prev = document.getElementById('cQrPreview');
  if (qrImagenActual) { prev.src = qrImagenActual; prev.style.display = ''; }
  else { prev.style.display = 'none'; }
  document.getElementById('btnCancelarCuenta').style.display = '';
  document.getElementById('btnGuardarCuenta').textContent = 'Guardar cambios';
  actualizarPrevisualizacionQr();
  document.getElementById('pCuentas').scrollIntoView({ behavior: 'smooth' });
};

document.getElementById('btnGuardarCuenta').addEventListener('click', async () => {
  const id = document.getElementById('cId').value;
  const banco = document.getElementById('cBanco').value.trim();
  const numero = document.getElementById('cNumero').value.trim();
  if (!banco || !numero) { alert('El banco y el número de cuenta son obligatorios.'); return; }

  const body = {
    banco, numero,
    alias: document.getElementById('cAlias').value.trim(),
    titular: document.getElementById('cTitular').value.trim(),
    moneda: document.getElementById('cMoneda').value,
    estado: document.getElementById('cEstado').value,
    usar_en: Array.from(document.querySelectorAll('.cUsarEn:checked')).map((c) => c.value),
    qr_datos: document.getElementById('cQrTexto').textContent,
    qr_imagen: qrImagenActual,
  };

  try {
    if (id) await API.actualizarCuentaBancaria(id, body);
    else await API.crearCuentaBancaria(body);
    sonar('exito');
    limpiarFormCuenta();
    await cargarCuentas();
  } catch (e) {
    alert('No se pudo guardar la cuenta: ' + e.message);
  }
});

window.borrarCuenta = async function borrarCuenta(id) {
  if (!confirm('¿Borrar esta cuenta bancaria?')) return;
  try {
    const r = await API.borrarCuentaBancaria(id);
    sonar(r.desactivada ? 'clic' : 'borrar');
    if (r.mensaje) alert(r.mensaje);
    await cargarCuentas();
  } catch (e) {
    alert('No se pudo borrar la cuenta: ' + e.message);
  }
};

// ============================================================
//  MOVIMIENTOS BANCARIOS
// ============================================================

async function cargarMovimientos() {
  if (!cuentasCache.length) await cargarCuentas();

  const filtros = {};
  const fCuenta = document.getElementById('fmCuenta').value;
  const fEstado = document.getElementById('fmEstado').value;
  const fDesde = document.getElementById('fmDesde').value;
  const fHasta = document.getElementById('fmHasta').value;
  if (fCuenta) filtros.cuenta_id = fCuenta;
  if (fEstado) filtros.estado = fEstado;
  if (fDesde) filtros.desde = fDesde;
  if (fHasta) filtros.hasta = fHasta;

  let filas;
  try { filas = await API.movimientosBancarios(filtros); }
  catch (e) { alert('No se pudo cargar los movimientos: ' + e.message); return; }

  const tb = document.getElementById('tbMovimientos');
  tb.innerHTML = filas.length ? filas.map((m) => `
    <tr>
      <td>${fechaHora(m.fecha)}</td>
      <td class="izq">${esc(m.cuenta_banco)} — ${esc(m.cuenta_alias || m.cuenta_numero)}</td>
      <td><span class="etq e-${m.tipo}">${m.tipo === 'ingreso' ? 'Ingreso' : 'Egreso'}</span></td>
      <td>${money(m.monto)} ${esc(m.moneda)}</td>
      <td class="izq">${esc(m.concepto || '—')}</td>
      <td class="izq">${esc(m.referencia || '—')}</td>
      <td><span class="etq e-${m.estado}">${esc(m.estado)}</span></td>
      <td>
        ${m.estado === 'conciliado'
          ? `<button class="btn-x" style="background:#607d8b" onclick="desconciliarMov(${m.id})">Desconciliar</button>`
          : `<button class="btn-x" style="background:#2e7d32" onclick="conciliarMov(${m.id})">Conciliar</button>`}
      </td>
    </tr>`).join('') : '<tr><td colspan="8" class="vacio">No hay movimientos con estos filtros.</td></tr>';
}

document.getElementById('btnFiltrarMov').addEventListener('click', cargarMovimientos);

document.getElementById('btnRegistrarMov').addEventListener('click', async () => {
  const cuenta_id = document.getElementById('mCuenta').value;
  const monto = document.getElementById('mMonto').value;
  if (!cuenta_id) { alert('Elija una cuenta bancaria.'); return; }
  if (!monto || Number(monto) <= 0) { alert('El monto debe ser mayor que cero.'); return; }

  const fechaInput = document.getElementById('mFecha').value;
  const body = {
    cuenta_id,
    tipo: document.getElementById('mTipo').value,
    monto,
    moneda: document.getElementById('mMoneda').value,
    fecha: fechaInput ? new Date(fechaInput).toISOString() : undefined,
    referencia: document.getElementById('mReferencia').value.trim(),
    concepto: document.getElementById('mConcepto').value.trim(),
    nota: document.getElementById('mNota').value.trim(),
  };

  try {
    await API.crearMovimientoBancario(body);
    sonar('exito');
    document.getElementById('mMonto').value = '';
    document.getElementById('mConcepto').value = '';
    document.getElementById('mReferencia').value = '';
    document.getElementById('mNota').value = '';
    await cargarMovimientos();
  } catch (e) {
    alert('No se pudo registrar el movimiento: ' + e.message);
  }
});

window.conciliarMov = async function conciliarMov(id) {
  const tipo = prompt('¿Con qué se concilia este movimiento? (ej. venta, compra, gasto)');
  if (!tipo) return;
  const idRef = prompt('Número/ID de referencia (opcional):') || null;
  try {
    await API.conciliarMovimientoBancario(id, { conciliado_tipo: tipo, conciliado_id: idRef });
    sonar('exito');
    await cargarMovimientos();
  } catch (e) {
    alert('No se pudo conciliar: ' + e.message);
  }
};

window.desconciliarMov = async function desconciliarMov(id) {
  if (!confirm('¿Desconciliar este movimiento?')) return;
  try {
    await API.conciliarMovimientoBancario(id, { desconciliar: true });
    sonar('clic');
    await cargarMovimientos();
  } catch (e) {
    alert('No se pudo desconciliar: ' + e.message);
  }
};

// ============================================================
//  PASARELAS DE PAGO
// ============================================================

async function cargarPasarelas() {
  let filas;
  try { filas = await API.pasarelasPago(); }
  catch (e) { alert('No se pudo cargar el estado de las pasarelas: ' + e.message); return; }

  const cont = document.getElementById('tarjetasPasarela');
  cont.innerHTML = filas.map((p) => `
    <div class="p-card ${p.disponible ? 'disponible' : 'no-disponible'}">
      <h4>${esc(p.nombre)}</h4>
      <div class="estado ${p.disponible ? 'si' : 'no'}">${p.disponible ? 'Disponible' : 'No disponible'}</div>
      ${p.entorno ? `<p>Entorno: <b>${esc(p.entorno)}</b></p>` : ''}
      ${p.motivo ? `<p>${esc(p.motivo)}</p>` : ''}
      ${p.variables_requeridas && p.variables_requeridas.length ? `
        <p><b>Variables de entorno necesarias:</b></p>
        <ul>${p.variables_requeridas.map((v) => `<li><code>${esc(v)}</code></li>`).join('')}</ul>
      ` : ''}
    </div>
  `).join('');
}

// ---------- Arranque ----------
cargarFiscal();
cargarCuentas();

// ============================================================
//  NÚMEROS PARA LOS AVISOS POR WHATSAPP
//
//  Se editan en una tabla porque son pocos y cambian: el transportista de
//  hoy no es el de la semana que viene. El número se guarda solo con
//  dígitos (así lo quiere wa.me); se puede escribir como sea.
// ============================================================
let numerosWa = [];

function pintarNumeros() {
  const tb = document.getElementById('tbWhatsapp');
  if (!tb) return;
  tb.innerHTML = numerosWa.length
    ? numerosWa.map((n, i) => `<tr>
        <td class="izq"><input type="text" data-i="${i}" data-c="nombre" value="${(n.nombre || '').replace(/"/g, '&quot;')}" placeholder="Ej. Transportista"></td>
        <td><input type="text" data-i="${i}" data-c="numero" value="${n.numero || ''}" placeholder="5355512345"></td>
        <td><input type="checkbox" data-i="${i}" data-c="envios" ${n.envios !== false ? 'checked' : ''}></td>
        <td><input type="checkbox" data-i="${i}" data-c="stock" ${n.stock ? 'checked' : ''}></td>
        <td><button type="button" class="btn-x" data-quitar="${i}">✕</button></td>
      </tr>`).join('')
    : '<tr><td colspan="5" class="vacio">Sin números. Añada al menos uno para avisar al transportista.</td></tr>';
}

document.getElementById('btnAgregarNumero')?.addEventListener('click', () => {
  numerosWa.push({ nombre: '', numero: '', envios: true, stock: false });
  pintarNumeros();
});

document.getElementById('tbWhatsapp')?.addEventListener('input', (ev) => {
  const el = ev.target;
  if (el.dataset.i === undefined) return;
  const n = numerosWa[Number(el.dataset.i)];
  if (!n) return;
  n[el.dataset.c] = el.type === 'checkbox' ? el.checked : el.value;
});

document.getElementById('tbWhatsapp')?.addEventListener('click', (ev) => {
  const q = ev.target.dataset && ev.target.dataset.quitar;
  if (q === undefined) return;
  numerosWa.splice(Number(q), 1);
  pintarNumeros();
});

document.getElementById('btnGuardarNumeros')?.addEventListener('click', async () => {
  try {
    const r = await API.guardarWhatsappNumeros(numerosWa);
    numerosWa = r.numeros || [];
    pintarNumeros();
    // El servidor descarta los que no tengan un número válido: si se
    // guardaron menos de los que había, hay que decirlo, no callarlo.
    alert('Guardado. Números activos: ' + numerosWa.length + '.');
  } catch (e) { alert('No se pudo guardar: ' + e.message); }
});

API.whatsappNumeros()
  .then((r) => { numerosWa = (r && r.numeros) || []; pintarNumeros(); })
  .catch(() => pintarNumeros());
