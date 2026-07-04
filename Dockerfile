# ── Étape 1 : build ──────────────────────────────────────────────────────────
FROM node:20-alpine AS build
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ── Étape 2 : runtime ────────────────────────────────────────────────────────
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=build /app/dist ./dist

# SIP (5060) + plage RTP par défaut (10000-20000), en UDP
EXPOSE 5060/udp
EXPOSE 10000-20000/udp

CMD ["node", "dist/server.js"]
