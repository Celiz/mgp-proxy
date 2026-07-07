# Usa la imagen oficial de Node.js (liviana)
FROM node:20-alpine

# Establece el directorio de trabajo
WORKDIR /app

# Copia los archivos de configuración
COPY package.json package-lock.json* ./

# Instala las dependencias
RUN npm install

# Copia el resto del código
COPY src ./src

# La aplicación escucha en el puerto 4000 por defecto
ENV PORT=4000
EXPOSE 4000

# Comando para ejecutar el proxy usando Node
CMD ["npm", "start"]
