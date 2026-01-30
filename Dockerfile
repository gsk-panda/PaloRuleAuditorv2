FROM node:20-alpine AS frontend-builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

FROM node:20-alpine AS backend-builder

WORKDIR /app

COPY package*.json ./
COPY tsconfig.json ./
COPY server/ ./server/
COPY services/ ./services/
COPY types.ts ./

RUN npm ci

FROM node:20-alpine

WORKDIR /app

RUN apk add --no-cache dumb-init

COPY package*.json ./
RUN npm ci --only=production && npm install tsx --save

COPY --from=backend-builder /app/server ./server
COPY --from=backend-builder /app/services ./services
COPY --from=backend-builder /app/types.ts ./
COPY --from=backend-builder /app/tsconfig.json ./
COPY --from=frontend-builder /app/dist ./public

ENV NODE_ENV=production
ENV PORT=3010

EXPOSE 3010

USER node

ENTRYPOINT ["dumb-init", "--"]
CMD ["npx", "tsx", "server/index.ts"]
