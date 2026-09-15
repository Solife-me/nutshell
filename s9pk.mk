# Keep the upstream project's existing Makefile targets while consuming the
# canonical StartOS build plumbing shipped by start-sdk.
ARCHES ?= x86 arm
.DEFAULT_GOAL := all

START_SDK_MAKEFILE := node_modules/@start9labs/start-sdk/s9pk.mk

$(START_SDK_MAKEFILE): package.json package-lock.json
	npm ci

# The SDK makefile recursively invokes make, so retain this wrapper on those
# recursive calls instead of falling back to the repository's main Makefile.
MAKE := $(MAKE) -f s9pk.mk

include $(START_SDK_MAKEFILE)
