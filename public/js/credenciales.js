// ============================================================
//  CONEXIONES EXTERNAS — pantalla
//
//  Aquí el dueño pone el token de elTOQUE (tasa del dólar), los datos
//  de Transfermóvil y lo que haga falta mañana, sin que nadie tenga
//  que tocar código ni volver a desplegar.
//
//  El valor guardado NUNCA vuelve del servidor: solo llega si está
//  puesto, de dónde sale y sus últimos cuatro caracteres. Por eso el
//  campo de texto siempre aparece vacío — no es un error, es que no
//  hay nada que rellenar. Quien ya lo puso no necesita releerlo, y
//  quien no debería verlo, tampoco.
// ============================================================

soloDuenoPagina();

const $lista = document.getElementById('listaCredenciales');

// Nombres legibles. Lo que llega del servidor es la clave técnica
// (ELTOQUE_TOKEN); en pantalla el dueño tiene que leer algo que
// entienda sin preguntar.
const NOMBRES = {
  ELTOQUE_TOKEN: 'Token de elTOQUE (tasa del dólar)',
  TRANSFERMOVIL_USUARIO: 'Transfermóvil — usuario',
  TRANSFERMOVIL_CLAVE: 'Transfermóvil — contraseña',
  TRANSFERMOVIL_TELEFONO: 'Transfermóvil — teléfono de cobro',
  ENZONA_CLIENT_ID: 'EnZona — identificador de comercio',
  ENZONA_CLIENT_SECRET: 'EnZona — clave secreta',
};

const ORIGEN = {
  base_datos: 'Puesta desde este panel',
  variable_entorno: 'Viene de la configuración del servidor',
};

function estado(c) {
  if (!c.puesta) return '<span class="estado-no">Sin configurar</span>';
  return `<span class="estado-si">Configurada ····${c.ultimos4 || ''}</span>`;
}

function pintar(lista) {
  if (!lista.length) {
    $lista.innerHTML = '<p class="sub">No hay conexiones declaradas.</p>';
    return;
  }

  $lista.innerHTML = lista
    .map(
      (c) => `
      <div class="tarjeta cred" data-clave="${c.clave}">
        <div class="cred-cabecera">
          <div>
            <strong>${NOMBRES[c.clave] || c.clave}</strong>
            <p class="sub">${c.descripcion || ''}</p>
          </div>
          <div class="cred-estado">
            ${estado(c)}
            ${c.origen ? `<small>${ORIGEN[c.origen] || ''}</small>` : ''}
          </div>
        </div>
        <div class="cred-acciones">
          <input type="password" class="cred-valor" placeholder="Escriba el valor nuevo" autocomplete="off">
          <button class="btn btn-guardar" type="button">Guardar</button>
          ${c.clave === 'ELTOQUE_TOKEN' ? '<button class="btn btn-probar" type="button">Probar</button>' : ''}
          ${c.origen === 'base_datos' ? '<button class="btn btn-borrar" type="button">Borrar</button>' : ''}
        </div>
        <p class="cred-aviso"></p>
      </div>`,
    )
    .join('');
}

async function cargar() {
  try {
    pintar(await API.credenciales());
  } catch (e) {
    $lista.innerHTML = `<p class="cred-error">${e.message}</p>`;
  }
}

// Un solo escuchador para toda la lista: las tarjetas se vuelven a
// dibujar en cada recarga, y enganchar botones uno a uno dejaría
// escuchadores viejos apuntando a nodos que ya no existen.
$lista.addEventListener('click', async (ev) => {
  const boton = ev.target.closest('button');
  if (!boton) return;

  const tarjeta = boton.closest('.cred');
  const clave = tarjeta.dataset.clave;
  const campo = tarjeta.querySelector('.cred-valor');
  const aviso = tarjeta.querySelector('.cred-aviso');

  aviso.textContent = '';
  aviso.className = 'cred-aviso';

  try {
    if (boton.classList.contains('btn-guardar')) {
      const valor = campo.value.trim();
      if (!valor) {
        aviso.textContent = 'Escriba el valor antes de guardar.';
        aviso.classList.add('malo');
        return;
      }
      await API.guardarCredencial(clave, valor);
      campo.value = '';
      await cargar();
      return;
    }

    if (boton.classList.contains('btn-borrar')) {
      if (!confirm('¿Borrar esta credencial? El servicio dejará de funcionar hasta que se ponga otra.')) return;
      await API.borrarCredencial(clave);
      await cargar();
      return;
    }

    if (boton.classList.contains('btn-probar')) {
      // "Guardado" no es lo mismo que "funciona". Esta prueba es la que
      // convierte una cosa en la otra: pide la tasa de verdad.
      boton.disabled = true;
      aviso.textContent = 'Consultando la tasa…';
      const r = await API.actualizarTasa();
      aviso.textContent = r && r.tasa ? `Funciona. Tasa recibida: ${r.tasa}` : 'Respondió, pero sin tasa. Revise el token.';
      aviso.classList.add(r && r.tasa ? 'bueno' : 'malo');
      boton.disabled = false;
    }
  } catch (e) {
    aviso.textContent = e.message;
    aviso.classList.add('malo');
    boton.disabled = false;
  }
});

cargar();
