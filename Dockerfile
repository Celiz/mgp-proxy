# Usa la imagen oficial de Bun (liviana)
FROM oven/bun:alpine

# Establece el directorio de trabajo
WORKDIR /app

# Copia los archivos de configuración
COPY package.json ./

# Instala las dependencias
RUN bun install

# Copia el resto del código
COPY src ./src

# La aplicación escucha en el puerto 4000 por defecto
ENV PORT=4000
EXPOSE 4000

# Comando para ejecutar el proxy
CMD ["bun", "start"]
