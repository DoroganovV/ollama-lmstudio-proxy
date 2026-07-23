FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY dist ./dist

ENV PORT=11434
EXPOSE 11434

CMD ["node", "dist/index.js"]
