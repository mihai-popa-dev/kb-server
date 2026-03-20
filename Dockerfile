FROM node:24-alpine

WORKDIR /app

COPY package*.json ./

RUN npm install --omit=dev

COPY . .

RUN mkdir -p /app/data /app/obsidian

EXPOSE 3000

CMD ["node", "src/index.js"]