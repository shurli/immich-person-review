FROM node:22-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund --ignore-scripts

COPY --chown=node:node server.mjs cluster-math.mjs tag-calibration.mjs ./
COPY --chown=node:node public ./public
COPY --chown=node:node data ./data

ENV NODE_ENV=production \
    PORT=3000

USER node
EXPOSE 3000

CMD ["node", "server.mjs"]
