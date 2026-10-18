FROM node:22-alpine

WORKDIR /app
COPY server ./server
COPY public ./public
COPY package.json ./

ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data
RUN mkdir -p /data
EXPOSE 8080

CMD ["node", "server/index.js"]
