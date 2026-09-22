FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund --ignore-scripts
COPY --chown=node:node server.mjs taxonomy-store.mjs legacy-taxonomy.mjs tag-calibration.mjs tag-preview.mjs ./
COPY --chown=node:node public ./public
COPY --chown=node:node data/tags.json ./defaults/tags.json
RUN mkdir -p /app/storage && chown node:node /app/storage
ENV NODE_ENV=production PORT=3000 \
    TAG_TAXONOMY_PATH=/app/storage/tags.json \
    TAG_TAXONOMY_DEFAULT_PATH=/app/defaults/tags.json
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "server.mjs"]
