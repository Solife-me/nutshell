# ** Plumbing. DO NOT EDIT **.
# This file is imported by the StartOS targets in ./Makefile. Make edits there.

PACKAGE_ID := $(shell awk -F"'" '/id:/ {print $$2}' startos/manifest/index.ts)
START_CLI ?= start-cli
INGREDIENTS := $(sort $(shell $(START_CLI) s9pk list-ingredients 2>/dev/null) instructions.md)
GIT_DIR := $(shell git rev-parse --git-dir 2>/dev/null)
GIT_DEPS := $(if $(GIT_DIR),$(GIT_DIR)/HEAD $(GIT_DIR)/index)
ARCHES ?= x86 arm
TARGETS ?= $(ARCHES)

ifdef VARIANT
BASE_NAME := $(PACKAGE_ID)_$(VARIANT)
else
BASE_NAME := $(PACKAGE_ID)
endif

.PHONY: all arches aarch64 x86_64 riscv64 arm arm64 x86 riscv arch/% clean install check-deps check-init package ingredients
.DELETE_ON_ERROR:
.SECONDARY:

define SUMMARY
	@manifest=$$($(START_CLI) s9pk inspect $(1) manifest); \
	size=$$(du -h $(1) | awk '{print $$1}'); \
	title=$$(printf '%s' "$$manifest" | jq -r .title); \
	version=$$(printf '%s' "$$manifest" | jq -r .version); \
	arches=$$(printf '%s' "$$manifest" | jq -r '[.images[].arch // []] | flatten | unique | join(", ")'); \
	sdkv=$$(printf '%s' "$$manifest" | jq -r .sdkVersion); \
	gitHash=$$(printf '%s' "$$manifest" | jq -r .gitHash | sed -E 's/(.*-modified)$$/\x1b[0;31m\1\x1b[0m/'); \
	printf "\n"; \
	printf "\033[1;32mBuild Complete\033[0m\n"; \
	printf "\n"; \
	printf "\033[1;37m $$title\033[0m \033[36mv$$version\033[0m\n"; \
	printf "%s\n" "-------------------------------"; \
	printf " \033[1;36mFilename:\033[0m %s\n" "$(1)"; \
	printf " \033[1;36mSize:\033[0m %s\n" "$$size"; \
	printf " \033[1;36mArch:\033[0m %s\n" "$$arches"; \
	printf " \033[1;36mSDK:\033[0m %s\n" "$$sdkv"; \
	printf " \033[1;36mGit:\033[0m %s\n" "$$gitHash"; \
	echo ""
endef

all: check-deps $(TARGETS)

arches: $(ARCHES)

print-%:
	@echo '$($*)'

universal: $(BASE_NAME).s9pk
	$(call SUMMARY,$<)

arch/%: $(BASE_NAME)_%.s9pk
	$(call SUMMARY,$<)

x86 x86_64: arch/x86_64
arm arm64 aarch64: arch/aarch64
riscv riscv64: arch/riscv64

$(BASE_NAME).s9pk: $(INGREDIENTS) $(GIT_DEPS) javascript/index.js
	@$(MAKE) --no-print-directory -f s9pk.mk ingredients
	@echo "Packing '$@'..."
	$(START_CLI) s9pk pack --instructions instructions.md -o $@

$(BASE_NAME)_%.s9pk: $(INGREDIENTS) $(GIT_DEPS) javascript/index.js
	@$(MAKE) --no-print-directory -f s9pk.mk ingredients
	@echo "Packing '$@'..."
	$(START_CLI) s9pk pack --arch=$* --instructions instructions.md -o $@

ingredients: $(INGREDIENTS)
	@echo "Re-evaluating ingredients..."

install: | check-deps check-init
	@HOST=$$(awk -F'/' '/^host:/ {print $$3}' ~/.startos/config.yaml); \
	if [ -z "$$HOST" ]; then \
		echo "Error: You must define \"host: http://server-name.local\" in ~/.startos/config.yaml"; \
		exit 1; \
	fi; \
	if [ -z "$$(ls *.s9pk 2>/dev/null)" ]; then \
		echo "Error: No .s9pk file found. Run 'make s9pk' first."; \
		exit 1; \
	fi; \
	S9PK=$$($(START_CLI) s9pk select) || exit 1; \
	printf "\nInstalling %s to %s ...\n" "$$S9PK" "$$HOST"; \
	$(START_CLI) package install -s "$$S9PK"

check-deps:
	@command -v $(START_CLI) >/dev/null || \
		(echo "Error: start-cli not found. Please see https://docs.start9.com/latest/developer-guide/sdk/installing-the-sdk" && exit 1)
	@$(START_CLI) s9pk pack --help | grep -q -- '--instructions' || \
		(echo "Error: start-cli is too old. Install StartOS 0.4.0-beta.9 or newer packaging tools." && exit 1)
	@command -v npm >/dev/null || \
		(echo "Error: npm not found. Please install Node.js and npm." && exit 1)

check-init:
	@if [ ! -f ~/.startos/developer.key.pem ]; then \
		echo "Initializing StartOS developer environment..."; \
		start-cli init-key; \
	fi

javascript/index.js: $(shell find startos -type f) tsconfig.json node_modules
	npm run check
	npm run build

node_modules: package-lock.json package.json
	npm ci

clean:
	@echo "Cleaning up StartOS build artifacts..."
	@rm -rf $(PACKAGE_ID).s9pk $(PACKAGE_ID)_x86_64.s9pk $(PACKAGE_ID)_aarch64.s9pk $(PACKAGE_ID)_riscv64.s9pk javascript node_modules
