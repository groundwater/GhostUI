.PHONY: help generate release debug clean icon native test test-e2e demo

-include .env
export

XCODEGEN ?= xcodegen
XCODEBUILD ?= xcodebuild
SCHEME ?= GhostUIApp
PROJECT = GhostUI.xcodeproj
DERIVED_DATA = .build/xcode
DEBUG_APP = $(DERIVED_DATA)/Build/Products/Debug/GhostUI.app
RELEASE_APP = $(DERIVED_DATA)/Build/Products/Release/GhostUI.app
TEST_E2E_GUI = $(abspath .build/GhostUI.app/Contents/Helpers/GhostUICLI.app/Contents/MacOS/gui)

# Icon generation
ICON_SOURCE = macOS/GhostUI/Resources/Icon/GhostUIIcon-final.png
ICON_ICONSET = macOS/GhostUI/Resources/Icon/GhostUI.iconset
ICON_OUTPUT = macOS/GhostUI/Resources/AppIcon.icns

help:
	@echo "Usage: make <target>"
	@echo ""
	@echo "Targets:"
	@echo "  generate  Generate GhostUI.xcodeproj from project.yml"
	@echo "  release   Build GhostUI (release)"
	@echo "  debug     Build GhostUI (debug)"
	@echo "  native    Build N-API accessibility module"
	@echo "  test      Run the standard GhostUI TypeScript verification flow"
	@echo "  test-e2e  Run the live gated CLI pipeline e2e matrix"
	@echo "  demo      Run the live screen-tour demo (env: DEMO_PAUSE_SCALE, DEMO_MAX_WINDOWS, DEMO_DURATION_S)"
	@echo "  icon      Generate AppIcon.icns from source PNG"
	@echo "  clean     Remove build artifacts"
	@echo ""
	@echo "Variables:"
	@echo "  XCODEGEN    xcodegen executable (default: xcodegen)"
	@echo "  XCODEBUILD  xcodebuild executable (default: xcodebuild)"

icon:
ifeq ($(SKIP_ICON),1)
	@echo "Skipping icon generation (SKIP_ICON=1)"
	@exit 0
endif
	@echo "Generating AppIcon.icns from source..."
	@xattr -rc $(ICON_ICONSET) 2>/dev/null || true
	@rm -rf $(ICON_ICONSET) 2>/dev/null || true
	@mkdir -p $(ICON_ICONSET)
	@sips -z 16 16     $(ICON_SOURCE) --out $(ICON_ICONSET)/icon_16x16.png >/dev/null 2>&1
	@sips -z 32 32     $(ICON_SOURCE) --out $(ICON_ICONSET)/icon_16x16@2x.png >/dev/null 2>&1
	@sips -z 32 32     $(ICON_SOURCE) --out $(ICON_ICONSET)/icon_32x32.png >/dev/null 2>&1
	@sips -z 64 64     $(ICON_SOURCE) --out $(ICON_ICONSET)/icon_32x32@2x.png >/dev/null 2>&1
	@sips -z 128 128   $(ICON_SOURCE) --out $(ICON_ICONSET)/icon_128x128.png >/dev/null 2>&1
	@sips -z 256 256   $(ICON_SOURCE) --out $(ICON_ICONSET)/icon_128x128@2x.png >/dev/null 2>&1
	@sips -z 256 256   $(ICON_SOURCE) --out $(ICON_ICONSET)/icon_256x256.png >/dev/null 2>&1
	@sips -z 512 512   $(ICON_SOURCE) --out $(ICON_ICONSET)/icon_256x256@2x.png >/dev/null 2>&1
	@sips -z 512 512   $(ICON_SOURCE) --out $(ICON_ICONSET)/icon_512x512.png >/dev/null 2>&1
	@sips -z 1024 1024 $(ICON_SOURCE) --out $(ICON_ICONSET)/icon_512x512@2x.png >/dev/null 2>&1
	@iconutil -c icns $(ICON_ICONSET) -o $(ICON_OUTPUT) || ( \
		echo "iconutil failed; keeping existing AppIcon.icns if present"; \
		test -f $(ICON_OUTPUT); \
	)
	@rm -rf $(ICON_ICONSET)
	@echo "✓ AppIcon.icns generated successfully"

generate:
	$(XCODEGEN) generate

native:
	@echo "Installing ghost dependencies..."
	cd macOS/ghost && bun install
	@echo "Building N-API accessibility module..."
	cd macOS/ghost/native && npm install --ignore-scripts
	mkdir -p macOS/ghost/native/build/Release/.deps/Release/obj.target/ghostui_ax
	cd macOS/ghost/native && npm run build
	@echo "N-API module built: macOS/ghost/native/build/Release/ghostui_ax.node"

test:
	cd macOS/ghost && bun x tsc --noEmit
	cd macOS/ghost && bun test src/server/routes.test.ts src/cli/filter.test.ts src/ax-event-policy.test.ts src/cli/main.test.ts src/cli/pipeline.test.ts src/cli/pipeline.process-e2e.test.ts

test-e2e:
	test -x "$(TEST_E2E_GUI)" || (echo "Bundled gui helper missing at $(TEST_E2E_GUI). Build GhostUI.app first."; exit 1)
	cd macOS/ghost && GHOSTUI_ENABLE_LIVE_PIPE_TESTS=1 GHOSTUI_TEST_GUI_PATH="$(TEST_E2E_GUI)" bun test --max-concurrency=1 --timeout=15000 src/cli/pipeline.live-e2e.test.ts
	cd macOS/ghost && GHOSTUI_ENABLE_LIVE_PIPE_TESTS=1 GHOSTUI_TEST_GUI_PATH="$(TEST_E2E_GUI)" bun test --max-concurrency=1 --timeout=15000 src/cli/actor.live-e2e.test.ts
	cd macOS/ghost && GHOSTUI_ENABLE_LIVE_PIPE_TESTS=1 GHOSTUI_TEST_GUI_PATH="$(TEST_E2E_GUI)" bun test --max-concurrency=1 --timeout=15000 src/cli/pipeline.live-gfx-e2e.test.ts
	cd macOS/ghost && GHOSTUI_ENABLE_LIVE_PIPE_TESTS=1 GHOSTUI_TEST_GUI_PATH="$(TEST_E2E_GUI)" bun test --max-concurrency=1 --timeout=15000 src/cli/pipeline.live-chain-e2e.test.ts
	cd macOS/ghost && GHOSTUI_ENABLE_LIVE_PIPE_TESTS=1 GHOSTUI_TEST_GUI_PATH="$(TEST_E2E_GUI)" bun test --max-concurrency=1 --timeout=15000 src/cli/pipeline.live-window-e2e.test.ts

demo:
	test -x "$(TEST_E2E_GUI)" || (echo "Bundled gui helper missing at $(TEST_E2E_GUI). Build GhostUI.app first."; exit 1)
	cd macOS/ghost && GHOSTUI_TEST_GUI_PATH="$(TEST_E2E_GUI)" bun run src/cli/demo-screen-tour.ts

release: icon generate
	$(XCODEBUILD) -project $(PROJECT) -scheme $(SCHEME) -configuration Release -destination 'generic/platform=macOS' -allowProvisioningUpdates -allowProvisioningDeviceRegistration -derivedDataPath $(DERIVED_DATA) build
	rm -rf .build/GhostUI.app
	ditto $(RELEASE_APP) .build/GhostUI.app

debug: icon generate
	$(XCODEBUILD) -project $(PROJECT) -scheme $(SCHEME) -configuration Debug -destination 'generic/platform=macOS' -allowProvisioningUpdates -allowProvisioningDeviceRegistration -derivedDataPath $(DERIVED_DATA) build
	rm -rf .build/GhostUI.app
	ditto $(DEBUG_APP) .build/GhostUI.app

clean:
	rm -rf .build/ GhostUI.xcodeproj
