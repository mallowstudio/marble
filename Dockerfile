FROM alpine/git:latest AS source

WORKDIR /repo
COPY . .

RUN apk add --no-cache git-lfs && \
    git lfs install && \
    git lfs pull

FROM node:22-alpine

WORKDIR /app
COPY --from=source /repo/ .

ENV NODE_ENV=production

CMD ["node", "server.js"]
