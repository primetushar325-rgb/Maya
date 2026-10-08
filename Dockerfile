FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /app/data \
  && chown -R node:node /app

WORKDIR /app
USER node

COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --include=dev --no-audit --no-fund
COPY --chown=node:node . .
RUN npm run build

ENV NODE_ENV=production
ENV PORT=4000
EXPOSE 4000
CMD ["npm", "run", "start:api"]
