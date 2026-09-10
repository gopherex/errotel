GO_DIR := services/errotel
PLAYWRIGHT_INSTALL_FLAGS ?=
VERSION ?= $(shell node -p "require('./packages/sdk/package.json').version")
COMMIT ?= $(shell git rev-parse HEAD)
BUILD_TIME ?= $(shell date -u +%Y-%m-%dT%H:%M:%SZ)
BUILD_PKG := github.com/gopherex/errotel/services/errotel/internal/build
LDFLAGS := -s -w -X $(BUILD_PKG).Version=$(VERSION) -X $(BUILD_PKG).Commit=$(COMMIT) -X $(BUILD_PKG).BuildTime=$(BUILD_TIME)
GOLANGCI_VERSION := v2.11.3
GOLANGCI := $(CURDIR)/bin/golangci-lint

.PHONY: lint lint-go lint-go-fix lint-fix tools test-go build generate
tools: $(GOLANGCI)

$(GOLANGCI):
	GOBIN=$(CURDIR)/bin go install github.com/golangci/golangci-lint/v2/cmd/golangci-lint@$(GOLANGCI_VERSION)

lint:
	yarn lint
	$(MAKE) lint-go

lint-go: tools
	cd $(GO_DIR) && $(GOLANGCI) run --config .golangci.yaml --build-tags=integration ./...

lint-go-fix: tools
	cd $(GO_DIR) && $(GOLANGCI) fmt --config .golangci.yaml
	cd $(GO_DIR) && $(GOLANGCI) run --config .golangci.yaml --build-tags=integration --fix ./...

lint-fix:
	yarn lint:fix
	$(MAKE) lint-go-fix

test-go:
	cd $(GO_DIR) && go test -race ./...

generate: generate-go
	yarn workspace @gopherex/errotel-api generate

generate-go:
	yarn contracts
	node scripts/openapi.mjs
	node scripts/openapi-go.mjs
	cd $(GO_DIR) && go run github.com/ogen-go/ogen/cmd/ogen@v1.20.3 --config .ogen.yaml --target internal/oas --package oas --clean ../../openapi/.build/openapi-go.json

build:
	yarn build
	cd $(GO_DIR) && go build -trimpath -ldflags "$(LDFLAGS)" -o ../../bin/errotel ./cmd/errotel

.PHONY: build-server test-integration stack-up stack-down seed
build-server:
	cd $(GO_DIR) && go build -trimpath -ldflags "$(LDFLAGS)" -o ../../bin/errotel ./cmd/errotel

test-integration:
	cd $(GO_DIR) && go test -race -tags=integration -count=1 ./tests/integration

stack-up:
	docker compose up --build -d

stack-down:
	docker compose down

seed:
	yarn seed

.PHONY: ci ci-vm check-generated test-packages test-release release release-plan release-artifacts
ci: check-generated
	yarn run check
	yarn typecheck:core
	$(MAKE) test-release test-packages

ci-vm:
	docker compose up -d victorialogs victoriatraces victoriametrics collector
	$(MAKE) build-server
	node scripts/test-service.mjs
	$(MAKE) test-integration
	yarn playwright install $(PLAYWRIGHT_INSTALL_FLAGS) chromium
	node scripts/test-dev.mjs
	yarn test:browser

check-generated:
	node scripts/check-generated.mjs

test-packages:
	yarn build
	node scripts/pack.mjs
	node scripts/test-packages.mjs

test-release:
	node --test tests/release/*.test.mjs

release:
	node scripts/release.mjs $(VERSION)

release-plan:
	node scripts/release.mjs --dry-run $(VERSION)

release-artifacts:
	yarn build
	node scripts/pack.mjs
	VERSION=$(VERSION) node scripts/release-artifacts.mjs

.PHONY: test-service
test-service: build-server
	node scripts/test-service.mjs
