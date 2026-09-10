FROM --platform=$BUILDPLATFORM node:22.23.1-bookworm-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3 AS ui
WORKDIR /workspace
COPY package.json yarn.lock ./
COPY packages ./packages
COPY app ./app
COPY docs ./docs
COPY scripts ./scripts
COPY openapi ./openapi
RUN yarn install --frozen-lockfile && yarn build:packages && yarn workspace @errotel/ui build

FROM --platform=$BUILDPLATFORM golang:1.26.7-alpine3.23 AS build
WORKDIR /src
COPY services/errotel/go.mod services/errotel/go.sum ./
RUN go mod download
COPY services/errotel/ ./
ARG TARGETOS
ARG TARGETARCH
ARG VERSION=dev
ARG COMMIT=unknown
ARG BUILD_TIME=unknown
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH go build -trimpath -ldflags "-s -w -X github.com/gopherex/errotel/services/errotel/internal/build.Version=$VERSION -X github.com/gopherex/errotel/services/errotel/internal/build.Commit=$COMMIT -X github.com/gopherex/errotel/services/errotel/internal/build.BuildTime=$BUILD_TIME" -o /errotel ./cmd/errotel

FROM alpine:3.23.3
RUN apk add --no-cache ca-certificates && adduser -D -u 10001 errotel
COPY --from=build /errotel /usr/local/bin/errotel
COPY --from=ui /workspace/app/dist /opt/errotel/ui
USER errotel
EXPOSE 8080 8081
ENTRYPOINT ["errotel", "-config", "/etc/errotel/config.yaml"]
