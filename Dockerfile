FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --include=dev
COPY . .
RUN npm run build

ENV NODE_ENV=production
ENV PORT=4000
EXPOSE 4000
CMD ["npm", "run", "start:api"]
