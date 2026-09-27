SHELL := /bin/bash
.DEFAULT_GOAL := help

REPO_ROOT := $(abspath $(dir $(lastword $(MAKEFILE_LIST))))
MACOS_SCRIPTS := $(REPO_ROOT)/scripts/macos

APP_SOURCE ?= $(REPO_ROOT)/apps/review-desktop/VSCode-darwin-arm64/Whiteboard.app
APP_DEST ?= /Applications/Whiteboard.app
SSH_HOST ?= truenas-dev-2
LOCAL_PORT ?= 34125
REMOTE_HOST ?= whiteboard
REMOTE_PORT ?= 34125

TUNNEL_ENV = SSH_HOST="$(SSH_HOST)" LOCAL_PORT="$(LOCAL_PORT)" REMOTE_HOST="$(REMOTE_HOST)" REMOTE_PORT="$(REMOTE_PORT)"
APP_ENV = WHITEBOARD_APP_SOURCE="$(APP_SOURCE)" WHITEBOARD_APP_DEST="$(APP_DEST)"

.PHONY: help build-app install-app uninstall-app open-app \
	install-tunnel start-tunnel stop-tunnel restart-tunnel status-tunnel \
	copy-token verify install uninstall

help:
	@printf '%s\n' \
	  'Whiteboard local macOS installer' \
	  '' \
	  '  make build-app       Build a self-contained, ad-hoc-signed Whiteboard.app' \
	  '  make install-app     Copy the built bundle to /Applications' \
	  '  make uninstall-app   Remove the installed application bundle' \
	  '  make open-app        Open the installed application' \
	  '  make install-tunnel  Install and start the per-user autossh LaunchAgent' \
	  '  make start-tunnel    Load/start the installed LaunchAgent' \
	  '  make stop-tunnel     Stop/unload the LaunchAgent' \
	  '  make restart-tunnel  Reload the LaunchAgent' \
	  '  make status-tunnel   Show LaunchAgent, listener, and endpoint status' \
	  '  make copy-token      Copy the remote Review Server token to the clipboard' \
	  '  make verify          Verify the installed app and tunnel' \
	  '  make install         Build/install the app and install/verify the tunnel' \
	  '  make uninstall       Remove the LaunchAgent and application bundle'

build-app:
	@$(MACOS_SCRIPTS)/with-node24.sh bash $(MACOS_SCRIPTS)/build-local-app.sh

install-app:
	@$(APP_ENV) $(MACOS_SCRIPTS)/app-install.sh install

uninstall-app:
	@$(APP_ENV) $(MACOS_SCRIPTS)/app-install.sh uninstall

open-app:
	@open "$(APP_DEST)"

install-tunnel:
	@$(TUNNEL_ENV) $(MACOS_SCRIPTS)/tunnel.sh install

start-tunnel:
	@$(TUNNEL_ENV) $(MACOS_SCRIPTS)/tunnel.sh start

stop-tunnel:
	@$(TUNNEL_ENV) $(MACOS_SCRIPTS)/tunnel.sh stop

restart-tunnel:
	@$(TUNNEL_ENV) $(MACOS_SCRIPTS)/tunnel.sh restart

status-tunnel:
	@$(TUNNEL_ENV) $(MACOS_SCRIPTS)/tunnel.sh status

copy-token:
	@ssh -o BatchMode=yes "$(SSH_HOST)" 'cat /home/dev/workspace/.service-data/whiteboard/review-server-token' | pbcopy
	@printf '%s\n' 'Copied the Review Server token to the macOS clipboard.'

verify:
	@$(APP_ENV) $(TUNNEL_ENV) $(MACOS_SCRIPTS)/verify-install.sh

install:
	@$(MAKE) build-app
	@$(MAKE) install-app
	@$(MAKE) install-tunnel
	@$(MAKE) verify

uninstall:
	@$(MAKE) stop-tunnel || true
	@$(TUNNEL_ENV) $(MACOS_SCRIPTS)/tunnel.sh uninstall
	@$(MAKE) uninstall-app
