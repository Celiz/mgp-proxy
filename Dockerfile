# Debian y no Alpine: el Chromium que instala patchright trae dependencias de
# sistema (libnss3, libatk, etc.) que no existen fácil en musl.
FROM node:22-bookworm-slim

# Nada de Xvfb/DISPLAY acá: a diferencia del approach anterior (CDP + Chrome
# real, que necesitaba un display de verdad para resolver el challenge de
# Cloudflare), el bridge Python usa Scrapling/patchright, que resuelve el
# Turnstile headless. Ver bridge/bridge.py.
RUN apt-get update && apt-get install -y --no-install-recommends \
        python3 python3-venv python3-pip \
        ca-certificates \
        libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
        libdbus-1-3 libxkbcommon0 libxcomposite1 libxdamage1 libxrandr2 \
        libgbm1 libpango-1.0-0 libcairo2 libasound2 libxshmfence1 \
        libxfixes3 libxi6 libxtst6 libxrender1 libxext6 libglib2.0-0 \
        libpixman-1-0 libatomic1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json* ./
# --include=dev explícito: tsx vive en devDependencies y es lo que arranca el
# server. Si el entorno trae NODE_ENV=production, npm lo omitiría y el
# contenedor moriría con "tsx: not found".
RUN npm install --include=dev

COPY bridge/requirements.txt bridge/requirements.txt
RUN python3 -m venv bridge/.venv \
    && bridge/.venv/bin/pip install --no-cache-dir --upgrade pip \
    && bridge/.venv/bin/pip install --no-cache-dir -r bridge/requirements.txt \
    && bridge/.venv/bin/patchright install chromium

COPY src ./src
COPY bridge ./bridge

ENV PORT=4000
EXPOSE 4000

CMD ["npm", "run", "start:docker"]
