// Gestión de Almacén — Cárnicos M&C
// Habla con el backend a través de js/api.js (window.API).

// Almacén: el rol Almacén, el Almacenero Central (que atiende todos los
// almacenes) y el Dueño.
if (!soloRoles(['almacen', 'almacenero', 'almacen_central'])) {
  throw new Error('sin acceso');
}

// El dueño ve el enlace para volver al panel; los demás roles no.
if (esDueno()) {
  const nav = document.getElementById('navPanel');
  nav.style.display = ''; nav.href = 'admin.html';
}

// Elementos del DOM
const btnAgregarProducto = document.getElementById('btnAgregarProducto');
const formProducto = document.getElementById('formProducto');
const productoForm = document.getElementById('productoForm');
const almacenList = document.getElementById('almacenList');
const movimientoForm = document.getElementById('movimientoForm');
const movProductoSelect = document.getElementById('movProducto');
const movAlmacenSelect = document.getElementById('movAlmacen');
const unidadProductoSelect = document.getElementById('unidadProducto');
const contadorProductos = document.getElementById('contadorProductos');
const contadorAlmacenes = document.getElementById('contadorAlmacenes');

const TIPO_LABEL = {
  materia_prima: 'Materia prima',
  terminado: 'Terminado',
  reventa: 'Reventa',
};

// Mostrar/ocultar formulario de nuevo producto
btnAgregarProducto.addEventListener('click', () => {
  formProducto.classList.toggle('hidden');
});

// Guardar nuevo producto
productoForm.addEventListener('submit', (e) => {
  e.preventDefault();

  const nombre = document.getElementById('nombreProducto').value.trim();
  const tipo = document.getElementById('tipoProducto').value;
  const unidad_id = Number(unidadProductoSelect.value) || null;
  const precio_costo = parseFloat(document.getElementById('precioCosto').value) || 0;
  const precioVentaVal = document.getElementById('precioVenta').value;
  const stockMinimoVal = document.getElementById('stockMinimo').value;

  const datos = {
    nombre,
    tipo,
    unidad_id,
    precio_costo,
    precio_venta: precioVentaVal ? parseFloat(precioVentaVal) : 0,
    stock_minimo: stockMinimoVal ? parseFloat(stockMinimoVal) : 0,
  };

  API.crearProducto(datos)
    .then(() => {
      productoForm.reset();
      formProducto.classList.add('hidden');
      cargarTodo();
    })
    .catch((error) => {
      console.error('Error al guardar producto:', error);
      alert('Error: ' + error.message);
    });
});

// El destino solo tiene sentido cuando se da SALIDA: se muestra u oculta.
const tipoMovSelect = document.getElementById('movTipo');
const bloqueDestino = document.getElementById('bloqueDestino');
if (tipoMovSelect && bloqueDestino) {
  const refrescarDestino = () => {
    bloqueDestino.classList.toggle('hidden', tipoMovSelect.value !== 'salida');
  };
  tipoMovSelect.addEventListener('change', refrescarDestino);
  refrescarDestino();
}

// Registrar movimiento (entrada/salida)
movimientoForm.addEventListener('submit', (e) => {
  e.preventDefault();

  const tipo = document.getElementById('movTipo').value;
  const datos = {
    producto_id: Number(movProductoSelect.value),
    almacen_id: Number(movAlmacenSelect.value),
    tipo,
    cantidad: parseFloat(document.getElementById('movCantidad').value),
    nota: document.getElementById('movNota').value.trim() || undefined,
  };

  // A dónde va lo que sale (opcional): otro almacén, o un lugar escrito.
  if (tipo === 'salida') {
    const destAlm = document.getElementById('movDestinoAlmacen');
    const destTxt = document.getElementById('movDestinoTexto');
    if (destAlm && destAlm.value) datos.destino_almacen_id = Number(destAlm.value);
    if (destTxt && destTxt.value.trim()) datos.destino_texto = destTxt.value.trim();
  }

  if (!datos.producto_id || !datos.almacen_id || !datos.cantidad) {
    alert('Complete producto, almacén y cantidad.');
    return;
  }

  API.registrarMovimiento(datos)
    .then(() => {
      movimientoForm.reset();
      if (bloqueDestino) bloqueDestino.classList.add('hidden');
      cargarTodo();
    })
    .catch((error) => {
      console.error('Error al registrar movimiento:', error);
      alert('Error: ' + error.message);
    });
});

// ============================================================
//  Lo que la cocina produjo, esperando entrada al almacén
//
//  El cocinero elabora y eso NO entra solo al almacén: aparece
//  aquí y el almacenero decide cuándo darle entrada.
// ============================================================
async function cargarProducido() {
  const bloque = document.getElementById('bloqueProducido');
  const cuerpo = document.getElementById('producidoList');
  if (!bloque || !cuerpo) return;

  let filas = [];
  try { filas = await API.produccionDisponible(); } catch (e) { filas = []; }

  if (!filas.length) { bloque.classList.add('hidden'); return; }
  bloque.classList.remove('hidden');

  const fecha = (f) => {
    if (!f) return '';
    const d = new Date(f);
    return d.toLocaleDateString('es-CU', { day: '2-digit', month: '2-digit' }) + ' ' +
      d.toLocaleTimeString('es-CU', { hour: '2-digit', minute: '2-digit' });
  };

  cuerpo.innerHTML = filas.map((f) => `
    <tr>
      <td><b>${f.producto_nombre}</b></td>
      <td>${Number(f.cantidad).toLocaleString('es-CU', { maximumFractionDigits: 3 })}</td>
      <td>${f.unidad || ''}</td>
      <td>${Number(f.costo_unitario || 0).toLocaleString('es-CU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
      <td>${fecha(f.fecha)}</td>
      <td><button onclick="darEntradaProducido(${f.id}, '${String(f.producto_nombre).replace(/'/g, "\\'")}')">Dar entrada</button></td>
    </tr>`).join('');
}

async function darEntradaProducido(id, nombre) {
  const almacenId = Number(movAlmacenSelect.value);
  if (!almacenId) { alert('Elija primero el almacén en el formulario de arriba.'); return; }
  if (!confirm(`¿Dar entrada de "${nombre}" al almacén?\n\nA partir de ahora contará como existencia.`)) return;
  try {
    await API.produccionAlAlmacen(id, almacenId);
    await cargarTodo();
  } catch (e) {
    alert('No se pudo dar entrada: ' + e.message);
  }
}

// Cargar unidades para los selects
function cargarUnidades() {
  return API.unidades().then((unidades) => {
    unidadProductoSelect.innerHTML = (unidades || [])
      .map((u) => `<option value="${u.id}">${u.nombre} (${u.abreviatura})</option>`)
      .join('');
  }).catch((error) => console.error('Error al cargar unidades:', error));
}

// Cargar almacenes (para el selector de movimiento y el contador)
function cargarAlmacenes() {
  return API.almacenes().then(async (almacenes) => {
    movAlmacenSelect.innerHTML = (almacenes || [])
      .map((a) => `<option value="${a.id}">${a.nombre}</option>`)
      .join('');
    contadorAlmacenes.textContent = `${(almacenes || []).length} almacenes`;

    // Para enviar mercancía a otro sitio hace falta ver TODOS los almacenes,
    // no solo el propio (un almacenero solo ve el suyo en la lista de arriba).
    const destino = document.getElementById('movDestinoAlmacen');
    if (destino) {
      let todos = almacenes || [];
      try { todos = await API.almacenesTodos(); } catch (e) { /* se queda con los suyos */ }
      const propio = Number(movAlmacenSelect.value);
      destino.innerHTML = '<option value="">¿A dónde va? (opcional)</option>' +
        todos.filter((a) => a.id !== propio)
          .map((a) => `<option value="${a.id}">${a.nombre}</option>`).join('');
    }
    return almacenes;
  }).catch((error) => console.error('Error al cargar almacenes:', error));
}

// Cargar productos (para el selector de movimiento)
function cargarProductosSelect() {
  return API.productos().then((productos) => {
    movProductoSelect.innerHTML = (productos || [])
      .map((p) => `<option value="${p.id}">${p.nombre}</option>`)
      .join('');
    return productos;
  }).catch((error) => console.error('Error al cargar productos:', error));
}

// Cargar y pintar la tabla de existencias
function cargarExistencias() {
  almacenList.innerHTML = '';

  return API.existencias().then((productos) => {
    contadorProductos.textContent = `${(productos || []).length} productos`;

    (productos || []).forEach((producto) => {
      const tr = document.createElement('tr');

      // Miniatura del producto; si no tiene foto, un recuadro neutro (no rompe la fila).
      const miniatura = producto.imagen
        ? `<img src="${producto.imagen}" class="rec-miniatura" alt="">`
        : `<span class="rec-miniatura rec-miniatura-vacia"></span>`;

      tr.innerHTML = `
        <td>${miniatura}</td>
        <td>${producto.nombre}</td>
        <td>${TIPO_LABEL[producto.tipo] || producto.tipo}</td>
        <td>${producto.unidad || ''}</td>
        <td>${producto.cantidad}</td>
        <td>${Number(producto.precio_costo || 0).toFixed(2)}</td>
        <td>
          <button onclick="eliminarProducto(${producto.id})">Eliminar</button>
        </td>
      `;

      if (producto.cantidad <= 0) {
        tr.classList.add('producto-agotado');
      }

      almacenList.appendChild(tr);
    });
  }).catch((error) => {
    console.error('Error al cargar existencias:', error);
  });
}

// Eliminar producto
function eliminarProducto(id) {
  if (!confirm('¿Eliminar este producto?')) return;

  API.eliminarProducto(id)
    .then(() => cargarTodo())
    .catch((error) => {
      console.error('Error al eliminar:', error);
      alert('Error: ' + error.message);
    });
}

// Cargar todo de nuevo (tras crear/eliminar/mover)
function cargarTodo() {
  cargarExistencias();
  cargarProductosSelect();
  cargarAlmacenes();
  cargarProducido();   // lo que la cocina dejó listo para entrar
}

// Carga inicial
cargarUnidades();
cargarTodo();
