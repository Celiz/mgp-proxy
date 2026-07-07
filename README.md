# MGP Proxy

Un servidor proxy ultra-ligero construido con [Hono](https://hono.dev/) y Node.js, diseñado específicamente para ejecutarse en Termux (Android). 
Actúa como escudo entre el frontend/backend principal y la API de la Municipalidad de General Pueyrredon (MGP), protegiendo contra baneos y colapsos mediante:

- **Rate Limiting Inteligente:** Limita a 2 peticiones por segundo por token usando el algoritmo Token Bucket.
- **Singleflight:** Si múltiples usuarios piden el arribo del mismo colectivo simultáneamente, solo 1 petición va a la Muni y el resultado se comparte con el resto.
- **Circuit Breaker:** Si la Muni empieza a devolver errores 429 (Too Many Requests), el circuito se abre y usa respuestas cacheadas (Stale Cache) para no sobrecargar la API pública.
- **Caché en Memoria (LRU):** Respuestas instantáneas para paradas consultadas recientemente.

## 🚀 Despliegue en Termux + Cloudflare

Este proxy está pensado para correr en un teléfono Android viejo conectado al WiFi de tu casa (IP residencial), evitando que la MGP bloquee IPs de servidores en la nube (AWS, Render, Vercel).

### 1. Requisitos en el Teléfono
Instalá Termux desde F-Droid o la Play Store. Adentro de Termux, instalá las dependencias necesarias:

```bash
pkg update
pkg install git nodejs
```

### 2. Instalación y Ejecución
Cloná este repositorio, instalá los paquetes de Node y dale arranque:

```bash
git clone https://github.com/TU_USUARIO/mgp-proxy.git
cd mgp-proxy
npm install
npm start
```
*Si todo salió bien, verás el mensaje: `[bondi-proxy] Iniciando en puerto 4000 con Node.js 🚀`.*

### 3. Exponer a Internet (Túnel de Cloudflare)
Para que tu backend en la nube pueda comunicarse con tu teléfono local, usamos Cloudflared. Abrí una **segunda pestaña** en Termux (deslizá desde el borde izquierdo y tocá "New Session") e instalá la herramienta:

```bash
pkg install cloudflared
```

**Opción A: Túnel Rápido (Temporal)**
Ideal para pruebas. Genera una URL aleatoria que cambia cada vez que lo reiniciás.
```bash
cloudflared tunnel --url http://localhost:4000
```
*(Buscá la URL que termina en `.trycloudflare.com` y configurala como `MGP_PROXY_URL` en tu backend principal).*

**Opción B: Túnel Permanente (Recomendado)**
Para tener siempre la misma URL sin tocar nada.
1. Autenticate con tu cuenta de Cloudflare:
   ```bash
   cloudflared tunnel login
   ```
2. Creá el túnel y rutealo a tu dominio:
   ```bash
   cloudflared tunnel create bondi-proxy
   cloudflared tunnel route dns bondi-proxy proxy.tudominio.com
   ```
3. Generá el archivo de configuración automáticamente:
   ```bash
   UUID=$(ls ~/.cloudflared | grep '\.json$' | head -n 1 | sed 's/.json//')
   cat << EOF > ~/.cloudflared/config.yml
   tunnel: bondi-proxy
   credentials-file: /data/data/com.termux/files/home/.cloudflared/$UUID.json
   
   ingress:
     - hostname: proxy.tudominio.com
       service: http://localhost:4000
     - service: http_status:404
   EOF
   ```
4. Prendelo:
   ```bash
   cloudflared tunnel run bondi-proxy
   ```

## 📊 Monitoreo
Podés verificar la salud de tu proxy, los circuitos, el caché y las métricas entrando a:
`http://localhost:4000/stats/data` (desde el celu) o `https://proxy.tudominio.com/stats/data` (desde la web).
