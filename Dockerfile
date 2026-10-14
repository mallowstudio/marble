FROM alpine/git:latest AS source

RUN apk add --no-cache git-lfs
RUN git lfs install

WORKDIR /repo

RUN git clone --depth 1 https://github.com/mallowstudio/marble.git . && \
    git lfs pull

FROM node:22-alpine

WORKDIR /app
COPY --from=source /repo/ .

RUN rm -rf .git

ENV NODE_ENV=production

CMD ["node", "server.js"]
