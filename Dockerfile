# Single-stage Node image. tsx runs the TS server directly (no tsc compile),
# and the globe assets are pre-bundled by `npm run build` (esbuild). Slim is
# fine — better-sqlite3 ships prebuilt binaries for linux-x64/glibc.
FROM node:22-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

RUN npm run build

ENV NODE_ENV=production
ENV WS_HOST=0.0.0.0
ENV WS_PORT=8787

EXPOSE 8787

CMD ["npm", "start"]
