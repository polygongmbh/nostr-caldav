FROM node:20-alpine AS base
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY config.example.yaml ./config.example.yaml
COPY README.md ./README.md

ENV NODE_ENV=production
ENV BRIDGE_CONFIG=/data/config.yaml

VOLUME ["/data"]
EXPOSE 5232

CMD ["node", "src/index.js"]
