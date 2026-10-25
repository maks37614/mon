FROM node:24.22.1-bookworm-slim AS build
WORKDIR /app
ENV NODE_OPTIONS=--max-old-space-size=512
COPY package.json package-lock.json ./
RUN node -e "const [a,b,c]=process.versions.node.split('.').map(Number);if(a<24||(a===24&&(b<22||(b===22&&c<1))))throw Error('Node.js 24.22.1+ required')" \
    && nice -n 10 npm ci --no-audit --no-fund
COPY . .
RUN nice -n 10 npm run typecheck \
    && nice -n 10 npm test \
    && nice -n 10 npm run build

FROM node:24.22.1-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3010 DATA_DIR=/data
COPY package.json package-lock.json ./
RUN nice -n 10 npm ci --omit=dev --no-audit --no-fund \
    && npm cache clean --force
COPY --from=build /app/build ./build
COPY --from=build /app/dist ./dist
COPY scripts/password.mjs scripts/configure.mjs ./scripts/
RUN mkdir /data && chown node:node /data
USER node
EXPOSE 3010
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s \
    CMD node -e "fetch('http://127.0.0.1:3010/healthz').then(r=>r.json()).then(v=>process.exit(v.ok&&v.app==='mon'?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--max-old-space-size=384", "build/server.mjs"]
