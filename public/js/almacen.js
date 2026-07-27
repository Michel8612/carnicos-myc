// Gestión de Almacén — Cárnicos M&C
// Habla con el backend a través de js/api.js (window.API).

// Almacén: solo el rol Almacén (o el Dueño).
if (!soloRoles(['almacen', 'almacenero'])) {
  throw new Error('sin acceso');
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

// Registrar movimiento (entrada/salida)
movimientoForm.addEventListener('submit', (e) => {
  e.preventDefault();

  const datos = {
    producto_id: Number(movProductoSelect.value),
    almacen_id: Number(movAlmacenSelect.value),
    tipo: document.getElementById('movTipo').value,
    cantidad: parseFloat(document.getElementById('movCantidad').value),
    nota: document.getElementById('movNota').value.trim() || undefined,
  };

  if (!datos.producto_id || !datos.almacen_id || !datos.cantidad) {
    alert('Complete producto, almacén y cantidad.');
    return;
  }

  API.registrarMovimiento(datos)
    .then(() => {
      movimientoForm.reset();
      cargarTodo();
    })
    .catch((error) => {
      console.error('Error al registrar movimiento:', error);
      alert('Error: ' + error.message);
    });
});

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
  return API.almacenes().then((almacenes) => {
    movAlmacenSelect.innerHTML = (almacenes || [])
      .map((a) => `<option value="${a.id}">${a.nombre}</option>`)
      .join('');
    contadorAlmacenes.textContent = `${(almacenes || []).length} almacenes`;
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

      tr.innerHTML = `
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
}

// Carga inicial
cargarUnidades();
cargarTodo();
