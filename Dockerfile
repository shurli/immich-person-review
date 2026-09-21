FROM node:22-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund --ignore-scripts

COPY --chown=node:node server.mjs cluster-math.mjs tag-calibration.mjs ./
COPY --chown=node:node public ./public
COPY --chown=node:node data/tags.json ./defaults/tags.json
RUN mkdir -p /app/storage && chown -R node:node /app/storage /app/defaults

ENV NODE_ENV=production \
    PORT=3000 \
    TAG_TAXONOMY_PATH=/app/storage/tags.json \
    TAG_TAXONOMY_DEFAULT_PATH=/app/defaults/tags.json

USER node
EXPOSE 3000

CMD ["node", "server.mjs"]
