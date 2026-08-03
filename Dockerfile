# ============================================================
#  Cárnicos M&C — imagen para instalar EN LA PC DEL CLIENTE
#
#  Esta imagen existe para que el sistema funcione SIN INTERNET.
#  La versión de Netlify depende de que haya conexión y de que
#  Neon esté despierto; aquí todo corre en la máquina del negocio:
#  el programa y su base de datos.
#
#  Alpine y no la imagen normal de Node: 40 MB contra 350 MB. En
#  Cuba la diferencia se nota al copiar el instalador por USB.
# ============================================================

FROM node:20-alpine

WORKDIR /app

# Primero solo las dependencias. Docker guarda esta capa y no la
# repite mientras no cambie package.json: reconstruir tras tocar
# código pasa de minutos a segundos.
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

# El código. `public/` son las pantallas y `backend/` el motor;
# server.js sirve las dos cosas cuando corre fuera de Netlify.
COPY backend/ ./backend/
COPY public/ ./public/

# El puerto de dentro del contenedor. El de fuera lo decide
# docker-compose, para no chocar con lo que ya tenga el cliente.
ENV PUERTO=3010
ENV NODE_ENV=production
EXPOSE 3010

# Sin TLS: la base viaja por la red interna de Docker, que no sale
# de la máquina. Exigir certificados aquí solo daría un fallo de
# conexión sin ganar nada.
ENV PGSSL=off

# Aviso de salud: si el proceso se queda colgado, Docker lo reinicia
# solo. Para un negocio que no tiene informático, esto es la
# diferencia entre "se arregló solo" y "hay que llamar a alguien".
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -q -O- http://127.0.0.1:3010/api/salud || exit 1

CMD ["node", "backend/src/server.js"]
