# syntax=docker/dockerfile:1.7

FROM node:22.17.1-bookworm-slim AS webui

WORKDIR /src/crates/agent-gateway/web
RUN npm install -g pnpm@10.32.1

COPY crates/agent-gateway/web/package.json crates/agent-gateway/web/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY crates/agent-gateway/web ./
RUN pnpm build

FROM golang:1.25-bookworm AS gateway-builder

ARG TARGETOS=linux
ARG TARGETARCH=amd64

WORKDIR /src/crates/agent-gateway

COPY crates/agent-gateway/go.mod crates/agent-gateway/go.sum ./
RUN go mod download

COPY crates/agent-gateway ./
COPY --from=webui /src/crates/agent-gateway/web/dist ./web/dist

RUN CGO_ENABLED=0 GOOS=${TARGETOS} GOARCH=${TARGETARCH} \
    go build -trimpath -ldflags="-s -w" -o /out/liveagent-gateway ./cmd/gateway

FROM debian:bookworm-slim AS runtime

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN useradd --system --uid 10001 --home-dir /nonexistent --shell /usr/sbin/nologin liveagent

COPY --from=gateway-builder /out/liveagent-gateway /usr/local/bin/liveagent-gateway

USER liveagent

ENV PORT=8080
ENV LIVEAGENT_GATEWAY_GRPC_ADDR=:50051

EXPOSE 8080 50051

ENTRYPOINT ["/usr/local/bin/liveagent-gateway"]
