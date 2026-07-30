// Helpers comunes para los scripts de prueba contra el servidor local.
const BASE = 'http://localhost:3012';

export async function login(usuario, clave) {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ usuario, clave }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`login ${usuario} fallo: ${JSON.stringify(j)}`);
  return j.token;
}

export async function api(method, path, token, body) {
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let j = null;
  try { j = await r.json(); } catch { j = null; }
  return { status: r.status, body: j };
}

export function assert(cond, msg) {
  if (!cond) {
    console.log(`  FALLA: ${msg}`);
    return false;
  }
  console.log(`  ok: ${msg}`);
  return true;
}

export const BASE_URL = BASE;
