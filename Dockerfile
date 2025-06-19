FROM node:24-alpine AS builder

WORKDIR /app

COPY package*.json ./

RUN npm ci --silent
RUN npm install -g typescript

COPY tsconfig.json ./
COPY src/ ./src/

RUN npm run build

# Production stage
FROM node:24-alpine AS production

WORKDIR /app

COPY package*.json ./

RUN npm ci --only=production --silent

COPY --from=builder /app/dist ./dist

RUN addgroup -g 1001 -S nodejs && \
    adduser -S mcp-router -u 1001

RUN chown -R mcp-router:nodejs /app
USER mcp-router

EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:4000/health || exit 1

ENV NODE_ENV=production
ENV ROUTER_PORT=4000

CMD ["node", "dist/index.js"]