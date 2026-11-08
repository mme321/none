FROM node:22-bookworm-slim

# כרומיום + גופנים בעברית – נדרשים למשיכת הנתונים מאתרי הבנקים
RUN apt-get update \
  && apt-get install -y --no-install-recommends chromium fonts-noto-core fonts-dejavu-core ca-certificates tini \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    PUPPETEER_SKIP_DOWNLOAD=1 \
    CHROME_PATH=/usr/bin/chromium \
    MAASER_NO_SANDBOX=1 \
    MAASER_DATA_DIR=/data \
    HOST=0.0.0.0 \
    PORT=8080 \
    TZ=Asia/Jerusalem

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .

RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 8080
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server.js"]
