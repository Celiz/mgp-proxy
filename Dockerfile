# Debian y no Alpine: hace falta Chromium para resolver el challenge de
# Cloudflare, y xvfb para darle un display — headless no lo pasa.
FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
        chromium xvfb xauth ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json* ./
# --include=dev explícito: tsx vive en devDependencies y es lo que arranca el
# server. Si el entorno trae NODE_ENV=production, npm lo omitiría y el contenedor
# moriría con "tsx: not found".
RUN npm install --include=dev

COPY src ./src

ENV PORT=4000
ENV MGP_BROWSER_PATH=/usr/bin/chromium
ENV DISPLAY=:99
EXPOSE 4000

# Xvfb explícito en vez de `xvfb-run`: el display queda levantado para todo el
# proceso y los logs de la app van derecho a stdout, que es lo que se mira
# cuando algo falla.
#
# `npm run start:docker` y no `npm start`: este último usa `npx`, que si no
# encuentra tsx instalado se cuelga esperando un "¿instalar? (y/n)" que en un
# contenedor nunca llega — se ve como un arranque mudo, sin abrir el puerto.
CMD ["sh", "-c", "Xvfb :99 -screen 0 1280x900x24 -nolisten tcp & exec npm run start:docker"]
