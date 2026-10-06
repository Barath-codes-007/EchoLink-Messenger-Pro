# ==========================================================================
# EchoLink Messenger — production Docker image
# Serves the Express API + Socket.IO server, which also serves /public
# statically, so this single image is the whole app.
# ==========================================================================

FROM node:20-alpine AS base
WORKDIR /usr/src/app

# better-sqlite3 needs build tools to compile its native binding on install.
RUN apk add --no-cache python3 make g++

COPY server/package*.json ./server/
RUN cd server && npm install --omit=dev --no-audit --no-fund

COPY server ./server
COPY public ./public

RUN mkdir -p server/data server/uploads

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

WORKDIR /usr/src/app/server
CMD ["node", "server.js"]
