# Debian y no Alpine: hace falta Chromium para resolver el challenge de
# Cloudflare, y xvfb para darle un display — headless no lo pasa.
FROM node:22-bookworm-slim

# xauth va sí o sí: sin él, xvfb-run aborta con "xauth command not found".
# Entra por --no-install-recommends, que lo deja afuera aunque xvfb lo sugiera.
RUN apt-get update && apt-get install -y --no-install-recommends \
        chromium xvfb xauth ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install

COPY src ./src

ENV PORT=4000
ENV MGP_BROWSER_PATH=/usr/bin/chromium
EXPOSE 4000

# xvfb-run le da el display virtual que el challenge necesita. El navegador se
# abre una sola vez (la cookie dura un año), así que no pesa en el día a día.
CMD ["xvfb-run", "-a", "npm", "start"]
