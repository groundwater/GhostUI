#import <napi.h>
#import <ApplicationServices/ApplicationServices.h>
#import <AppKit/AppKit.h>
#import <CoreGraphics/CoreGraphics.h>
#import <Security/Security.h>
#include <chrono>
#include <signal.h>
#include <vector>

// ─── Helpers ───────────────────────────────────────────────────────────────────

// Track the most recent explicit app activation we observed so snapshot-time
// frontmost resolution can follow the same event stream.
static pid_t g_lastFrontPid = 0;

static NSString* cfToNS(CFTypeRef ref) {
    if (!ref) return nil;
    if (CFGetTypeID(ref) == CFStringGetTypeID()) {
        return (__bridge NSString*)ref;
    }
    return nil;
}

static std::string cfToStd(CFTypeRef ref) {
    NSString* s = cfToNS(ref);
    return s ? std::string([s UTF8String]) : "";
}

static std::string axGetString(AXUIElementRef el, CFStringRef attr) {
    CFTypeRef val = NULL;
    AXError err = AXUIElementCopyAttributeValue(el, attr, &val);
    if (err != kAXErrorSuccess || !val) return "";
    std::string result = cfToStd(val);
    CFRelease(val);
    return result;
}

static bool appHasVisibleLayer0Window(pid_t pid) {
    if (pid <= 0) return false;
    CFArrayRef windowList = CGWindowListCopyWindowInfo(
        kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements,
        kCGNullWindowID
    );
    if (!windowList) return false;

    bool hasVisibleWindow = false;
    CFIndex count = CFArrayGetCount(windowList);
    for (CFIndex i = 0; i < count; i++) {
        CFDictionaryRef win = (CFDictionaryRef)CFArrayGetValueAtIndex(windowList, i);
        CFNumberRef pidRef = (CFNumberRef)CFDictionaryGetValue(win, kCGWindowOwnerPID);
        CFNumberRef layerRef = (CFNumberRef)CFDictionaryGetValue(win, kCGWindowLayer);
        CFDictionaryRef boundsRef = (CFDictionaryRef)CFDictionaryGetValue(win, kCGWindowBounds);
        if (!pidRef || !boundsRef) continue;

        int winPid = 0;
        int layer = 0;
        CFNumberGetValue(pidRef, kCFNumberIntType, &winPid);
        if (layerRef) CFNumberGetValue(layerRef, kCFNumberIntType, &layer);
        if (winPid != pid || layer != 0) continue;

        CGRect rect = CGRectZero;
        if (!CGRectMakeWithDictionaryRepresentation(boundsRef, &rect)) continue;
        if (rect.size.width < 20 || rect.size.height < 20) continue;

        hasVisibleWindow = true;
        break;
    }

    CFRelease(windowList);
    return hasVisibleWindow;
}

static bool processExists(pid_t pid) {
    if (pid <= 0) return false;
    int rc = kill(pid, 0);
    return rc == 0 || errno == EPERM;
}

static bool shouldIncludeWorkspaceRunningApp(NSRunningApplication* app) {
    if (!app) return false;
    if (app.activationPolicy == NSApplicationActivationPolicyProhibited) return false;
    if (app.isTerminated) return false;
    return true;
}

static bool shouldIncludeRecoveredRunningApp(NSRunningApplication* app) {
    if (!shouldIncludeWorkspaceRunningApp(app)) return false;
    if (!processExists(app.processIdentifier)) return false;
    return true;
}

struct RunningAppInfo {
    pid_t pid = 0;
    std::string bundleId;
    std::string name;
    bool regular = false;
};

struct FrontmostAppInfo {
    pid_t pid = 0;
    std::string bundleId;
    std::string name;
    bool valid = false;
};

static FrontmostAppInfo getWorkspaceFrontmostAppInfo(bool pumpRunLoop = false) {
    __block FrontmostAppInfo info;
    auto lookup = ^{
        @autoreleasepool {
            if (pumpRunLoop) {
                [[NSRunLoop currentRunLoop] runMode:NSDefaultRunLoopMode beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.01]];
            }
            NSRunningApplication* app = [[NSWorkspace sharedWorkspace] frontmostApplication];
            if (!shouldIncludeRecoveredRunningApp(app)) return;
            info.pid = app.processIdentifier;
            info.bundleId = app.bundleIdentifier ? std::string([app.bundleIdentifier UTF8String]) : "";
            info.name = app.localizedName ? std::string([app.localizedName UTF8String]) : "";
            info.valid = true;
        }
    };

    if ([NSThread isMainThread]) {
        lookup();
    } else {
        dispatch_sync(dispatch_get_main_queue(), lookup);
    }
    return info;
}

static bool findWorkspaceRunningAppMatching(NSString* query, RunningAppInfo& out) {
    __block bool found = false;
    auto lookup = ^{
        @autoreleasepool {
            NSArray<NSRunningApplication*>* runningApps = [[NSWorkspace sharedWorkspace] runningApplications];
            NSRunningApplication* target = nil;
            for (NSRunningApplication* app in runningApps) {
                if (!shouldIncludeWorkspaceRunningApp(app)) continue;
                if (app.bundleIdentifier && [app.bundleIdentifier isEqualToString:query]) {
                    target = app;
                    break;
                }
                if (app.localizedName && [app.localizedName caseInsensitiveCompare:query] == NSOrderedSame) {
                    target = app;
                    break;
                }
                if (app.localizedName && [app.localizedName localizedCaseInsensitiveContainsString:query]) {
                    if (!target) target = app;
                }
            }
            if (!target) return;
            out.pid = target.processIdentifier;
            out.bundleId = target.bundleIdentifier ? std::string([target.bundleIdentifier UTF8String]) : "";
            out.name = target.localizedName ? std::string([target.localizedName UTF8String]) : "";
            out.regular = target.activationPolicy == NSApplicationActivationPolicyRegular;
            found = true;
        }
    };

    if ([NSThread isMainThread]) {
        lookup();
    } else {
        dispatch_sync(dispatch_get_main_queue(), lookup);
    }
    return found;
}

static bool activateWorkspaceApp(pid_t pid) {
    __block bool activated = false;
    auto activate = ^{
        @autoreleasepool {
            NSRunningApplication* target = [NSRunningApplication runningApplicationWithProcessIdentifier:pid];
            if (!shouldIncludeRecoveredRunningApp(target)) return;
            activated = [target activateWithOptions:(NSApplicationActivateIgnoringOtherApps | NSApplicationActivateAllWindows)];
        }
    };

    if ([NSThread isMainThread]) {
        activate();
    } else {
        dispatch_sync(dispatch_get_main_queue(), activate);
    }
    return activated;
}

static std::vector<RunningAppInfo> collectWorkspaceRunningApps() {
    __block std::vector<RunningAppInfo> apps;
    auto collect = ^{
        @autoreleasepool {
            NSArray<NSRunningApplication*>* runningApps = [[NSWorkspace sharedWorkspace] runningApplications];
            apps.reserve((size_t)[runningApps count]);
            for (NSRunningApplication* app in runningApps) {
                if (!shouldIncludeWorkspaceRunningApp(app)) continue;
                RunningAppInfo info;
                info.pid = app.processIdentifier;
                info.bundleId = app.bundleIdentifier ? std::string([app.bundleIdentifier UTF8String]) : "";
                info.name = app.localizedName ? std::string([app.localizedName UTF8String]) : "";
                info.regular = app.activationPolicy == NSApplicationActivationPolicyRegular;
                apps.push_back(std::move(info));
            }
        }
    };

    if ([NSThread isMainThread]) {
        collect();
    } else {
        dispatch_sync(dispatch_get_main_queue(), collect);
    }
    return apps;
}

static bool lookupRunningAppInfo(pid_t pid, RunningAppInfo& out) {
    if (pid <= 0) return false;
    __block bool found = false;
    auto lookup = ^{
        @autoreleasepool {
            NSRunningApplication* app = [NSRunningApplication runningApplicationWithProcessIdentifier:pid];
            if (!shouldIncludeRecoveredRunningApp(app)) return;
            out.pid = app.processIdentifier;
            out.bundleId = app.bundleIdentifier ? std::string([app.bundleIdentifier UTF8String]) : "";
            out.name = app.localizedName ? std::string([app.localizedName UTF8String]) : "";
            out.regular = app.activationPolicy == NSApplicationActivationPolicyRegular;
            found = true;
        }
    };

    if ([NSThread isMainThread]) {
        lookup();
    } else {
        dispatch_sync(dispatch_get_main_queue(), lookup);
    }
    return found;
}

static void appendRunningAppInfo(Napi::Env env, Napi::Array result, uint32_t& idx, NSRunningApplication* app) {
    auto obj = Napi::Object::New(env);
    obj.Set("pid", (double)app.processIdentifier);
    obj.Set("bundleId", app.bundleIdentifier
        ? std::string([app.bundleIdentifier UTF8String]) : "");
    obj.Set("name", app.localizedName
        ? std::string([app.localizedName UTF8String]) : "");
    obj.Set("regular", app.activationPolicy == NSApplicationActivationPolicyRegular);
    result.Set(idx++, obj);
}

static void appendRunningAppInfo(Napi::Env env, Napi::Array result, uint32_t& idx, const RunningAppInfo& app) {
    auto obj = Napi::Object::New(env);
    obj.Set("pid", (double)app.pid);
    obj.Set("bundleId", app.bundleId);
    obj.Set("name", app.name);
    obj.Set("regular", app.regular);
    result.Set(idx++, obj);
}

static NSMutableSet<NSNumber*>* visibleLayer0WindowOwnerPids() {
    NSMutableSet<NSNumber*>* pids = [NSMutableSet set];
    CFArrayRef windowList = CGWindowListCopyWindowInfo(
        kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements,
        kCGNullWindowID
    );
    if (!windowList) return pids;

    CFIndex count = CFArrayGetCount(windowList);
    for (CFIndex i = 0; i < count; i++) {
        CFDictionaryRef win = (CFDictionaryRef)CFArrayGetValueAtIndex(windowList, i);
        CFNumberRef pidRef = (CFNumberRef)CFDictionaryGetValue(win, kCGWindowOwnerPID);
        CFNumberRef layerRef = (CFNumberRef)CFDictionaryGetValue(win, kCGWindowLayer);
        CFDictionaryRef boundsRef = (CFDictionaryRef)CFDictionaryGetValue(win, kCGWindowBounds);
        if (!pidRef || !boundsRef) continue;

        int pid = 0;
        int layer = 0;
        CFNumberGetValue(pidRef, kCFNumberIntType, &pid);
        if (layerRef) CFNumberGetValue(layerRef, kCFNumberIntType, &layer);
        if (pid <= 0 || layer != 0) continue;

        CGRect rect = CGRectZero;
        if (!CGRectMakeWithDictionaryRepresentation(boundsRef, &rect)) continue;
        if (rect.size.width < 20 || rect.size.height < 20) continue;

        [pids addObject:@(pid)];
    }

    CFRelease(windowList);
    return pids;
}

static bool axGetBool(AXUIElementRef el, CFStringRef attr, bool fallback = false) {
    CFTypeRef val = NULL;
    AXError err = AXUIElementCopyAttributeValue(el, attr, &val);
    if (err != kAXErrorSuccess || !val) return fallback;
    bool result = fallback;
    if (CFGetTypeID(val) == CFBooleanGetTypeID()) {
        result = CFBooleanGetValue((CFBooleanRef)val);
    } else if (CFGetTypeID(val) == CFNumberGetTypeID()) {
        int n = 0;
        CFNumberGetValue((CFNumberRef)val, kCFNumberIntType, &n);
        result = n != 0;
    }
    CFRelease(val);
    return result;
}

static std::string osStatusMessage(OSStatus status) {
    CFStringRef messageRef = SecCopyErrorMessageString(status, NULL);
    if (!messageRef) {
        return "OSStatus " + std::to_string(status);
    }
    std::string message = cfToStd(messageRef);
    CFRelease(messageRef);
    if (message.empty()) {
        return "OSStatus " + std::to_string(status);
    }
    return message + " (" + std::to_string(status) + ")";
}

struct AXFrame {
    double x, y, w, h;
    bool valid;
};

static AXFrame axGetFrame(AXUIElementRef el) {
    AXFrame f = {0, 0, 0, 0, false};

    CFTypeRef posVal = NULL;
    CFTypeRef sizeVal = NULL;
    AXUIElementCopyAttributeValue(el, kAXPositionAttribute, &posVal);
    AXUIElementCopyAttributeValue(el, kAXSizeAttribute, &sizeVal);

    if (posVal && sizeVal) {
        CGPoint pos;
        CGSize size;
        if (AXValueGetValue((AXValueRef)posVal, (AXValueType)kAXValueCGPointType, &pos) &&
            AXValueGetValue((AXValueRef)sizeVal, (AXValueType)kAXValueCGSizeType, &size)) {
            f = {pos.x, pos.y, size.width, size.height, true};
        }
    }
    if (posVal) CFRelease(posVal);
    if (sizeVal) CFRelease(sizeVal);
    return f;
}

// ─── AX Tree Walking ───────────────────────────────────────────────────────────

static Napi::Object walkAXTree(Napi::Env env, AXUIElementRef el, int depth, int maxDepth) {
    auto node = Napi::Object::New(env);

    // Role
    std::string role = axGetString(el, kAXRoleAttribute);
    node.Set("role", role);

    // Subrole
    std::string subrole = axGetString(el, kAXSubroleAttribute);
    if (!subrole.empty()) node.Set("subrole", subrole);

    // Title
    std::string title = axGetString(el, kAXTitleAttribute);
    if (!title.empty()) node.Set("title", title);

    // Description (label)
    std::string desc = axGetString(el, kAXDescriptionAttribute);
    if (!desc.empty()) node.Set("label", desc);

    // Value
    CFTypeRef rawVal = NULL;
    AXUIElementCopyAttributeValue(el, kAXValueAttribute, &rawVal);
    if (rawVal) {
        if (CFGetTypeID(rawVal) == CFStringGetTypeID()) {
            std::string strVal = cfToStd(rawVal);

            // For AXTextArea roles (e.g. Terminal.app), clip to visible content
            // to avoid returning the entire scrollback buffer.
            if (role == "AXTextArea") {
                CFTypeRef rangeVal = NULL;
                AXError rangeErr = AXUIElementCopyAttributeValue(el, kAXVisibleCharacterRangeAttribute, &rangeVal);
                if (rangeErr == kAXErrorSuccess && rangeVal) {
                    CFRange visibleRange;
                    if (AXValueGetValue((AXValueRef)rangeVal, (AXValueType)kAXValueCFRangeType, &visibleRange)) {
                        // CFRange uses UTF-16 code unit indices — convert via NSString
                        NSString* nsStr = (__bridge NSString*)(CFStringRef)rawVal;
                        CFIndex len = (CFIndex)[nsStr length];
                        CFIndex loc = visibleRange.location;
                        CFIndex rngLen = visibleRange.length;
                        if (loc >= 0 && loc < len) {
                            if (loc + rngLen > len) rngLen = len - loc;
                            NSString* clipped = [nsStr substringWithRange:NSMakeRange((NSUInteger)loc, (NSUInteger)rngLen)];
                            strVal = std::string([clipped UTF8String]);
                        }
                    }
                    CFRelease(rangeVal);
                }
            }

            node.Set("value", strVal);
        } else if (CFGetTypeID(rawVal) == CFNumberGetTypeID()) {
            double d = 0;
            CFNumberGetValue((CFNumberRef)rawVal, kCFNumberDoubleType, &d);
            node.Set("value", d);
        } else if (CFGetTypeID(rawVal) == CFBooleanGetTypeID()) {
            node.Set("value", (bool)CFBooleanGetValue((CFBooleanRef)rawVal));
        }
        CFRelease(rawVal);
    }

    // Identifier
    std::string ident = axGetString(el, CFSTR("AXIdentifier"));
    if (!ident.empty()) node.Set("identifier", ident);

    if (role == "AXWindow") {
        CFTypeRef windowNumberVal = NULL;
        AXError windowNumberErr = AXUIElementCopyAttributeValue(el, CFSTR("AXWindowNumber"), &windowNumberVal);
        if (windowNumberErr == kAXErrorSuccess && windowNumberVal && CFGetTypeID(windowNumberVal) == CFNumberGetTypeID()) {
            int windowNumber = 0;
            if (CFNumberGetValue((CFNumberRef)windowNumberVal, kCFNumberIntType, &windowNumber)) {
                node.Set("windowNumber", windowNumber);
            }
        }
        if (windowNumberVal) CFRelease(windowNumberVal);
    }

    // Frame
    AXFrame frame = axGetFrame(el);
    if (frame.valid) {
        auto f = Napi::Object::New(env);
        f.Set("x", frame.x);
        f.Set("y", frame.y);
        f.Set("width", frame.w);
        f.Set("height", frame.h);
        node.Set("frame", f);
    }

    // Placeholder
    std::string placeholder = axGetString(el, CFSTR("AXPlaceholderValue"));
    if (!placeholder.empty()) node.Set("placeholder", placeholder);

    // Capabilities object (matches SnapshotResponse AXNode shape)
    {
        auto caps = Napi::Object::New(env);
        bool hasCaps = false;

        bool enabled = axGetBool(el, CFSTR("AXEnabled"), true);
        if (!enabled) { caps.Set("enabled", false); hasCaps = true; }

        bool selected = axGetBool(el, CFSTR("AXSelected"), false);
        if (selected) { caps.Set("selected", true); hasCaps = true; }

        // AXValue can indicate checked state for checkboxes (value=1 means checked)
        if (role == "AXCheckBox" || role == "AXRadioButton") {
            CFTypeRef chkVal = NULL;
            AXUIElementCopyAttributeValue(el, kAXValueAttribute, &chkVal);
            if (chkVal) {
                if (CFGetTypeID(chkVal) == CFNumberGetTypeID()) {
                    int v = 0;
                    CFNumberGetValue((CFNumberRef)chkVal, kCFNumberIntType, &v);
                    if (v != 0) { caps.Set("checked", true); hasCaps = true; }
                } else if (CFGetTypeID(chkVal) == CFBooleanGetTypeID()) {
                    if (CFBooleanGetValue((CFBooleanRef)chkVal)) { caps.Set("checked", true); hasCaps = true; }
                }
                CFRelease(chkVal);
            }
        }

        bool expanded = axGetBool(el, CFSTR("AXExpanded"), false);
        if (expanded) { caps.Set("expanded", true); hasCaps = true; }

        bool focused = axGetBool(el, CFSTR("AXFocused"), false);
        if (focused) { caps.Set("focused", true); hasCaps = true; }

        // Scroll info for AXScrollArea
        if (role == "AXScrollArea") {
            // Check children for AXScrollBar to determine scroll capability and values
            CFTypeRef scrollChildren = NULL;
            AXError scrollErr = AXUIElementCopyAttributeValue(el, kAXChildrenAttribute, &scrollChildren);
            if (scrollErr == kAXErrorSuccess && scrollChildren && CFGetTypeID(scrollChildren) == CFArrayGetTypeID()) {
                CFArrayRef scrollKids = (CFArrayRef)scrollChildren;
                bool hasV = false, hasH = false;
                double valueV = 0, valueH = 0;
                for (CFIndex si = 0; si < CFArrayGetCount(scrollKids); si++) {
                    AXUIElementRef scrollChild = (AXUIElementRef)CFArrayGetValueAtIndex(scrollKids, si);
                    std::string childRole = axGetString(scrollChild, kAXRoleAttribute);
                    if (childRole != "AXScrollBar") continue;
                    std::string orient = axGetString(scrollChild, kAXOrientationAttribute);
                    CFTypeRef scrollVal = NULL;
                    AXUIElementCopyAttributeValue(scrollChild, kAXValueAttribute, &scrollVal);
                    double sv = 0;
                    if (scrollVal && CFGetTypeID(scrollVal) == CFNumberGetTypeID()) {
                        CFNumberGetValue((CFNumberRef)scrollVal, kCFNumberDoubleType, &sv);
                    }
                    if (scrollVal) CFRelease(scrollVal);
                    if (orient == "AXVerticalOrientation") { hasV = true; valueV = sv; }
                    else if (orient == "AXHorizontalOrientation") { hasH = true; valueH = sv; }
                }
                if (hasV || hasH) {
                    caps.Set("canScroll", true);
                    hasCaps = true;
                    if (hasV && hasH) caps.Set("scrollAxis", std::string("both"));
                    else if (hasV) caps.Set("scrollAxis", std::string("vertical"));
                    else caps.Set("scrollAxis", std::string("horizontal"));
                    if (hasV) caps.Set("scrollValueV", valueV);
                    if (hasH) caps.Set("scrollValueH", valueH);
                }
                CFRelease(scrollChildren);
            }
        }

        if (hasCaps) node.Set("capabilities", caps);
    }

    // Actions
    CFArrayRef actionsRef = NULL;
    AXUIElementCopyActionNames(el, &actionsRef);
    if (actionsRef) {
        auto actions = Napi::Array::New(env);
        CFIndex count = CFArrayGetCount(actionsRef);
        for (CFIndex i = 0; i < count; i++) {
            CFStringRef a = (CFStringRef)CFArrayGetValueAtIndex(actionsRef, i);
            actions.Set((uint32_t)i, cfToStd(a));
        }
        node.Set("actions", actions);
        CFRelease(actionsRef);
    }

    // Children (recurse)
    if (depth < maxDepth) {
        CFTypeRef childrenRef = NULL;
        AXError err = AXUIElementCopyAttributeValue(el, kAXChildrenAttribute, &childrenRef);
        if (err == kAXErrorSuccess && childrenRef && CFGetTypeID(childrenRef) == CFArrayGetTypeID()) {
            CFArrayRef children = (CFArrayRef)childrenRef;
            CFIndex count = CFArrayGetCount(children);
            if (count > 0) {
                auto arr = Napi::Array::New(env);
                for (CFIndex i = 0; i < count; i++) {
                    AXUIElementRef child = (AXUIElementRef)CFArrayGetValueAtIndex(children, i);
                    arr.Set((uint32_t)i, walkAXTree(env, child, depth + 1, maxDepth));
                }
                node.Set("children", arr);
            }
        }
        if (childrenRef) CFRelease(childrenRef);
    }

    return node;
}

static bool isTextCursorRole(const std::string& role) {
    return role == "AXTextField"
        || role == "AXTextArea"
        || role == "AXComboBox"
        || role == "AXSearchField";
}

// ─── Exported Functions ────────────────────────────────────────────────────────

// axSnapshot(pid: number, maxDepth?: number): AXNode
static Napi::Value AxSnapshot(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 1 || !info[0].IsNumber()) {
        Napi::TypeError::New(env, "Expected pid (number)").ThrowAsJavaScriptException();
        return env.Null();
    }

    pid_t pid = info[0].As<Napi::Number>().Int32Value();
    int maxDepth = 100;
    if (info.Length() > 1 && info[1].IsNumber()) {
        maxDepth = info[1].As<Napi::Number>().Int32Value();
    }

    AXUIElementRef appEl = AXUIElementCreateApplication(pid);
    if (!appEl) {
        Napi::Error::New(env, "Failed to create AXUIElement for pid").ThrowAsJavaScriptException();
        return env.Null();
    }

    Napi::Object result = walkAXTree(env, appEl, 0, maxDepth);
    CFRelease(appEl);
    return result;
}

// axGetCursor(): { pid, node, selection? } | null
// Returns the focused text-editable AX element plus its selected text range when available.
static Napi::Value AxGetCursor(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    AXUIElementRef systemWide = AXUIElementCreateSystemWide();
    if (!systemWide) return env.Null();

    CFTypeRef focusedAppValue = NULL;
    AXError focusedAppErr = AXUIElementCopyAttributeValue(systemWide, kAXFocusedApplicationAttribute, &focusedAppValue);
    if (focusedAppErr != kAXErrorSuccess || !focusedAppValue) {
        if (focusedAppValue) CFRelease(focusedAppValue);
        CFRelease(systemWide);
        return env.Null();
    }

    pid_t pid = 0;
    AXUIElementGetPid((AXUIElementRef)focusedAppValue, &pid);
    CFRelease(focusedAppValue);
    if (pid <= 0) {
        CFRelease(systemWide);
        return env.Null();
    }

    AXUIElementRef appEl = AXUIElementCreateApplication(pid);
    if (!appEl) {
        CFRelease(systemWide);
        return env.Null();
    }

    CFTypeRef focusedElValue = NULL;
    AXError focusedErr = AXUIElementCopyAttributeValue(appEl, kAXFocusedUIElementAttribute, &focusedElValue);
    if (focusedErr != kAXErrorSuccess || !focusedElValue) {
        if (focusedElValue) CFRelease(focusedElValue);
        CFRelease(appEl);
        CFRelease(systemWide);
        return env.Null();
    }

    AXUIElementRef focusedEl = (AXUIElementRef)focusedElValue;
    std::string role = axGetString(focusedEl, kAXRoleAttribute);
    if (!isTextCursorRole(role)) {
        CFRelease(focusedEl);
        CFRelease(appEl);
        CFRelease(systemWide);
        return env.Null();
    }

    auto result = Napi::Object::New(env);
    result.Set("pid", (double)pid);
    result.Set("node", walkAXTree(env, focusedEl, 0, 0));

    CFTypeRef rangeVal = NULL;
    AXError rangeErr = AXUIElementCopyAttributeValue(focusedEl, kAXSelectedTextRangeAttribute, &rangeVal);
    if (rangeErr == kAXErrorSuccess && rangeVal && CFGetTypeID(rangeVal) == AXValueGetTypeID()) {
        CFRange range = CFRangeMake(0, 0);
        if (AXValueGetValue((AXValueRef)rangeVal, (AXValueType)kAXValueCFRangeType, &range)) {
            auto selection = Napi::Object::New(env);
            selection.Set("location", (double)range.location);
            selection.Set("length", (double)range.length);
            result.Set("selection", selection);
        }
    }
    if (rangeVal) CFRelease(rangeVal);

    CFRelease(focusedEl);
    CFRelease(appEl);
    CFRelease(systemWide);
    return result;
}

// axPerformAction(pid: number, elementPath: number[], action: string): boolean
// elementPath is an array of child indices to navigate to the target element
static Napi::Value AxPerformAction(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 3) {
        Napi::TypeError::New(env, "Expected (pid, elementPath, action)").ThrowAsJavaScriptException();
        return env.Null();
    }

    pid_t pid = info[0].As<Napi::Number>().Int32Value();
    Napi::Array path = info[1].As<Napi::Array>();
    std::string action = info[2].As<Napi::String>().Utf8Value();

    AXUIElementRef el = AXUIElementCreateApplication(pid);
    if (!el) {
        Napi::Error::New(env, "Failed to create AXUIElement for pid").ThrowAsJavaScriptException();
        return env.Null();
    }

    // Navigate to target element via child indices
    for (uint32_t i = 0; i < path.Length(); i++) {
        uint32_t idx = path.Get(i).As<Napi::Number>().Uint32Value();
        CFTypeRef childrenRef = NULL;
        AXError err = AXUIElementCopyAttributeValue(el, kAXChildrenAttribute, &childrenRef);
        if (err != kAXErrorSuccess || !childrenRef) {
            CFRelease(el);
            return Napi::Boolean::New(env, false);
        }
        CFArrayRef children = (CFArrayRef)childrenRef;
        if ((CFIndex)idx >= CFArrayGetCount(children)) {
            CFRelease(childrenRef);
            CFRelease(el);
            return Napi::Boolean::New(env, false);
        }
        AXUIElementRef child = (AXUIElementRef)CFArrayGetValueAtIndex(children, idx);
        CFRetain(child);
        CFRelease(childrenRef);
        CFRelease(el);
        el = child;
    }

    CFStringRef actionStr = CFStringCreateWithCString(NULL, action.c_str(), kCFStringEncodingUTF8);
    AXError err = AXUIElementPerformAction(el, actionStr);
    CFRelease(actionStr);
    CFRelease(el);

    return Napi::Boolean::New(env, err == kAXErrorSuccess);
}

// axSetValue(pid: number, elementPath: number[], value: string): boolean
static Napi::Value AxSetValue(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 3) {
        Napi::TypeError::New(env, "Expected (pid, elementPath, value)").ThrowAsJavaScriptException();
        return env.Null();
    }

    pid_t pid = info[0].As<Napi::Number>().Int32Value();
    Napi::Array path = info[1].As<Napi::Array>();
    std::string value = info[2].As<Napi::String>().Utf8Value();

    AXUIElementRef el = AXUIElementCreateApplication(pid);
    if (!el) {
        Napi::Error::New(env, "Failed to create AXUIElement for pid").ThrowAsJavaScriptException();
        return env.Null();
    }

    // Navigate to target element
    for (uint32_t i = 0; i < path.Length(); i++) {
        uint32_t idx = path.Get(i).As<Napi::Number>().Uint32Value();
        CFTypeRef childrenRef = NULL;
        AXError err = AXUIElementCopyAttributeValue(el, kAXChildrenAttribute, &childrenRef);
        if (err != kAXErrorSuccess || !childrenRef) {
            CFRelease(el);
            return Napi::Boolean::New(env, false);
        }
        CFArrayRef children = (CFArrayRef)childrenRef;
        if ((CFIndex)idx >= CFArrayGetCount(children)) {
            CFRelease(childrenRef);
            CFRelease(el);
            return Napi::Boolean::New(env, false);
        }
        AXUIElementRef child = (AXUIElementRef)CFArrayGetValueAtIndex(children, idx);
        CFRetain(child);
        CFRelease(childrenRef);
        CFRelease(el);
        el = child;
    }

    CFStringRef valStr = CFStringCreateWithCString(NULL, value.c_str(), kCFStringEncodingUTF8);
    AXError err = AXUIElementSetAttributeValue(el, kAXValueAttribute, valStr);
    CFRelease(valStr);
    CFRelease(el);

    return Napi::Boolean::New(env, err == kAXErrorSuccess);
}

// axSetSelectedTextRange(pid: number, elementPath: number[], location: number, length: number): boolean
static Napi::Value AxSetSelectedTextRange(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 4) {
        Napi::TypeError::New(env, "Expected (pid, elementPath, location, length)").ThrowAsJavaScriptException();
        return env.Null();
    }

    pid_t pid = info[0].As<Napi::Number>().Int32Value();
    Napi::Array path = info[1].As<Napi::Array>();
    int64_t location = info[2].As<Napi::Number>().Int64Value();
    int64_t length = info[3].As<Napi::Number>().Int64Value();

    AXUIElementRef el = AXUIElementCreateApplication(pid);
    if (!el) {
        Napi::Error::New(env, "Failed to create AXUIElement for pid").ThrowAsJavaScriptException();
        return env.Null();
    }

    for (uint32_t i = 0; i < path.Length(); i++) {
        uint32_t idx = path.Get(i).As<Napi::Number>().Uint32Value();
        CFTypeRef childrenRef = NULL;
        AXError err = AXUIElementCopyAttributeValue(el, kAXChildrenAttribute, &childrenRef);
        if (err != kAXErrorSuccess || !childrenRef) {
            CFRelease(el);
            return Napi::Boolean::New(env, false);
        }
        CFArrayRef children = (CFArrayRef)childrenRef;
        if ((CFIndex)idx >= CFArrayGetCount(children)) {
            CFRelease(childrenRef);
            CFRelease(el);
            return Napi::Boolean::New(env, false);
        }
        AXUIElementRef child = (AXUIElementRef)CFArrayGetValueAtIndex(children, idx);
        CFRetain(child);
        CFRelease(childrenRef);
        CFRelease(el);
        el = child;
    }

    CFRange range = CFRangeMake(location, length);
    AXValueRef rangeVal = AXValueCreate(static_cast<AXValueType>(kAXValueCFRangeType), &range);
    AXError err = rangeVal ? AXUIElementSetAttributeValue(el, kAXSelectedTextRangeAttribute, rangeVal) : kAXErrorFailure;
    if (rangeVal) CFRelease(rangeVal);
    CFRelease(el);

    return Napi::Boolean::New(env, err == kAXErrorSuccess);
}

// axSetWindowPosition(pid: number, elementPath: number[], x: number, y: number): boolean
static Napi::Value AxSetWindowPosition(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 4) {
        Napi::TypeError::New(env, "Expected (pid, elementPath, x, y)").ThrowAsJavaScriptException();
        return env.Null();
    }

    pid_t pid = info[0].As<Napi::Number>().Int32Value();
    Napi::Array path = info[1].As<Napi::Array>();
    double x = info[2].As<Napi::Number>().DoubleValue();
    double y = info[3].As<Napi::Number>().DoubleValue();

    AXUIElementRef el = AXUIElementCreateApplication(pid);
    if (!el) {
        Napi::Error::New(env, "Failed to create AXUIElement for pid").ThrowAsJavaScriptException();
        return env.Null();
    }

    for (uint32_t i = 0; i < path.Length(); i++) {
        uint32_t idx = path.Get(i).As<Napi::Number>().Uint32Value();
        CFTypeRef childrenRef = NULL;
        AXError err = AXUIElementCopyAttributeValue(el, kAXChildrenAttribute, &childrenRef);
        if (err != kAXErrorSuccess || !childrenRef) {
            CFRelease(el);
            return Napi::Boolean::New(env, false);
        }
        CFArrayRef children = (CFArrayRef)childrenRef;
        if ((CFIndex)idx >= CFArrayGetCount(children)) {
            CFRelease(childrenRef);
            CFRelease(el);
            return Napi::Boolean::New(env, false);
        }
        AXUIElementRef child = (AXUIElementRef)CFArrayGetValueAtIndex(children, idx);
        CFRetain(child);
        CFRelease(childrenRef);
        CFRelease(el);
        el = child;
    }

    CGPoint point = CGPointMake(x, y);
    AXValueType pointType = static_cast<AXValueType>(kAXValueCGPointType);
    AXValueRef posVal = AXValueCreate(pointType, &point);
    AXError err = posVal ? AXUIElementSetAttributeValue(el, kAXPositionAttribute, posVal) : kAXErrorFailure;
    if (posVal) CFRelease(posVal);
    CFRelease(el);

    return Napi::Boolean::New(env, err == kAXErrorSuccess);
}

// axFocusWindow(pid: number, elementPath: number[]): boolean
static Napi::Value AxFocusWindow(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 2) {
        Napi::TypeError::New(env, "Expected (pid, elementPath)").ThrowAsJavaScriptException();
        return env.Null();
    }

    pid_t pid = info[0].As<Napi::Number>().Int32Value();
    Napi::Array path = info[1].As<Napi::Array>();

    FrontmostAppInfo front = getWorkspaceFrontmostAppInfo(true);
    if (!(front.valid && front.pid == pid)) {
        activateWorkspaceApp(pid);
    }

    AXUIElementRef appEl = AXUIElementCreateApplication(pid);
    if (!appEl) {
        Napi::Error::New(env, "Failed to create AXUIElement for pid").ThrowAsJavaScriptException();
        return env.Null();
    }

    AXUIElementRef el = appEl;
    CFRetain(el);
    for (uint32_t i = 0; i < path.Length(); i++) {
        uint32_t idx = path.Get(i).As<Napi::Number>().Uint32Value();
        CFTypeRef childrenRef = NULL;
        AXError err = AXUIElementCopyAttributeValue(el, kAXChildrenAttribute, &childrenRef);
        if (err != kAXErrorSuccess || !childrenRef) {
            CFRelease(el);
            CFRelease(appEl);
            return Napi::Boolean::New(env, false);
        }
        CFArrayRef children = (CFArrayRef)childrenRef;
        if ((CFIndex)idx >= CFArrayGetCount(children)) {
            CFRelease(childrenRef);
            CFRelease(el);
            CFRelease(appEl);
            return Napi::Boolean::New(env, false);
        }
        AXUIElementRef child = (AXUIElementRef)CFArrayGetValueAtIndex(children, idx);
        CFRetain(child);
        CFRelease(childrenRef);
        CFRelease(el);
        el = child;
    }

    // Activate the owning application so the window can actually come frontmost.
    // Without this, setting AX attributes on a background app's window is a no-op.
    activateWorkspaceApp(pid);

    bool ok = false;
    if (AXUIElementPerformAction(el, kAXRaiseAction) == kAXErrorSuccess) {
        ok = true;
    }
    if (AXUIElementSetAttributeValue(appEl, kAXFocusedWindowAttribute, el) == kAXErrorSuccess) {
        ok = true;
    }
    if (AXUIElementSetAttributeValue(el, kAXMainAttribute, kCFBooleanTrue) == kAXErrorSuccess) {
        ok = true;
    }
    if (AXUIElementSetAttributeValue(el, kAXFocusedAttribute, kCFBooleanTrue) == kAXErrorSuccess) {
        ok = true;
    }

    CFRelease(el);
    CFRelease(appEl);
    return Napi::Boolean::New(env, ok);
}

// axIsProcessTrusted(): boolean
static Napi::Value AxIsProcessTrusted(const Napi::CallbackInfo& info) {
    return Napi::Boolean::New(info.Env(), AXIsProcessTrusted());
}

// axRequestAccessibility(prompt: boolean): boolean
// If prompt=true, shows the system accessibility permission dialog
static Napi::Value AxRequestAccessibility(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    bool prompt = true;
    if (info.Length() > 0 && info[0].IsBoolean()) {
        prompt = info[0].As<Napi::Boolean>().Value();
    }
    NSDictionary* opts = @{(__bridge NSString*)kAXTrustedCheckOptionPrompt: @(prompt)};
    bool trusted = AXIsProcessTrustedWithOptions((__bridge CFDictionaryRef)opts);
    return Napi::Boolean::New(env, trusted);
}

// axGetFrontmostPid(): number
// Skips GhostUI itself — as an overlay/tool app it should never be
// reported as frontmost. Falls back to the next visible app.
static Napi::Value AxGetFrontmostPid(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    pid_t ownPid = [[NSProcessInfo processInfo] processIdentifier];
    FrontmostAppInfo frontApp = getWorkspaceFrontmostAppInfo();
    if (!frontApp.valid) return env.Null();

    // Prefer the last explicit activation event we observed when it still owns
    // a visible layer-0 window. App-switch notifications are often fresher than
    // NSWorkspace/AX focus queries during rapid frontmost transitions.
    if (g_lastFrontPid > 0 && g_lastFrontPid != ownPid && appHasVisibleLayer0Window(g_lastFrontPid)) {
        return Napi::Number::New(env, g_lastFrontPid);
    }

    // Prefer NSWorkspace when it resolves to a real visible app. AX focus can
    // get stuck on the previously focused text field even after another app is
    // visually frontmost, which leaves the daemon pinned to the wrong PID.
    if (frontApp.pid != ownPid && appHasVisibleLayer0Window(frontApp.pid)) {
        return Napi::Number::New(env, frontApp.pid);
    }

    // Fall back to AX focus when NSWorkspace is GhostUI itself or lacks a real
    // visible window for the reported front app.
    AXUIElementRef systemWide = AXUIElementCreateSystemWide();
    if (systemWide) {
        CFTypeRef focusedAppValue = NULL;
        AXError focusedErr = AXUIElementCopyAttributeValue(systemWide, kAXFocusedApplicationAttribute, &focusedAppValue);
        if (focusedErr == kAXErrorSuccess && focusedAppValue) {
            pid_t focusedPid = 0;
            AXUIElementGetPid((AXUIElementRef)focusedAppValue, &focusedPid);
            CFRelease(focusedAppValue);
            CFRelease(systemWide);
            if (focusedPid > 0 && focusedPid != ownPid && appHasVisibleLayer0Window(focusedPid)) {
                return Napi::Number::New(env, focusedPid);
            }
        } else {
            if (focusedAppValue) CFRelease(focusedAppValue);
            CFRelease(systemWide);
        }
    }
    if (frontApp.pid != ownPid) {
        return Napi::Number::New(env, frontApp.pid);
    }
    // GhostUI is frontmost — find the real user-facing app.
    // Walk the window list (front-to-back z-order) and return the first
    // non-GhostUI, non-system, layer-0 window's owning app.
    CFArrayRef windowList = CGWindowListCopyWindowInfo(
        kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements,
        kCGNullWindowID
    );
    if (windowList) {
        CFIndex count = CFArrayGetCount(windowList);
        for (CFIndex i = 0; i < count; i++) {
            CFDictionaryRef win = (CFDictionaryRef)CFArrayGetValueAtIndex(windowList, i);
            CFNumberRef layerRef = (CFNumberRef)CFDictionaryGetValue(win, kCGWindowLayer);
            int layer = 0;
            if (layerRef) CFNumberGetValue(layerRef, kCFNumberIntType, &layer);
            if (layer != 0) continue;
            CFNumberRef pidRef = (CFNumberRef)CFDictionaryGetValue(win, kCGWindowOwnerPID);
            pid_t winPid = 0;
            if (pidRef) CFNumberGetValue(pidRef, kCFNumberIntType, &winPid);
            if (winPid == 0 || winPid == ownPid) continue;
            CFRelease(windowList);
            return Napi::Number::New(env, winPid);
        }
        CFRelease(windowList);
    }
    // No other app found — return GhostUI's own PID as last resort
    return Napi::Number::New(env, frontApp.pid);
}

// wsGetRunningApps(): { pid, bundleId, name, regular }[]
static Napi::Value WsGetRunningApps(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    auto result = Napi::Array::New(env);

    NSMutableSet<NSNumber*>* seenPids = [NSMutableSet set];
    uint32_t idx = 0;
    for (const RunningAppInfo& app : collectWorkspaceRunningApps()) {
        [seenPids addObject:@(app.pid)];
        appendRunningAppInfo(env, result, idx, app);
    }

    for (NSNumber* pidNum in visibleLayer0WindowOwnerPids()) {
        if ([seenPids containsObject:pidNum]) continue;
        RunningAppInfo app;
        if (!lookupRunningAppInfo(pidNum.intValue, app)) continue;
        appendRunningAppInfo(env, result, idx, app);
    }
    return result;
}

// wsGetFrontmostApp(): { pid, bundleId, name } | null
static Napi::Value WsGetFrontmostApp(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    FrontmostAppInfo app = getWorkspaceFrontmostAppInfo();
    if (!app.valid) return env.Null();

    auto obj = Napi::Object::New(env);
    obj.Set("pid", (double)app.pid);
    obj.Set("bundleId", app.bundleId);
    obj.Set("name", app.name);
    return obj;
}

// wsGetScreenFrame(): { x, y, width, height } | null
static Napi::Value WsGetScreenFrame(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    NSScreen* screen = [NSScreen mainScreen];
    if (!screen) return env.Null();

    NSRect frame = screen.frame;
    auto obj = Napi::Object::New(env);
    obj.Set("x", frame.origin.x);
    obj.Set("y", frame.origin.y);
    obj.Set("width", frame.size.width);
    obj.Set("height", frame.size.height);
    return obj;
}

// cgGetWindowRects(): { pid, cgWindowId, x, y, w, h, title, layer }[]
static Napi::Value CgGetWindowRects(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    auto result = Napi::Array::New(env);

    CFArrayRef windowList = CGWindowListCopyWindowInfo(
        kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements,
        kCGNullWindowID
    );
    if (!windowList) return result;

    uint32_t idx = 0;
    CFIndex count = CFArrayGetCount(windowList);
    for (CFIndex i = 0; i < count; i++) {
        CFDictionaryRef win = (CFDictionaryRef)CFArrayGetValueAtIndex(windowList, i);

        // Get PID
        CFNumberRef pidRef = (CFNumberRef)CFDictionaryGetValue(win, kCGWindowOwnerPID);
        if (!pidRef) continue;
        int pid = 0;
        CFNumberGetValue(pidRef, kCFNumberIntType, &pid);

        // Get stable CG window id
        CFNumberRef windowIdRef = (CFNumberRef)CFDictionaryGetValue(win, kCGWindowNumber);
        int windowId = 0;
        if (windowIdRef) CFNumberGetValue(windowIdRef, kCFNumberIntType, &windowId);

        // Get bounds
        CFDictionaryRef boundsRef = (CFDictionaryRef)CFDictionaryGetValue(win, kCGWindowBounds);
        if (!boundsRef) continue;
        CGRect rect;
        CGRectMakeWithDictionaryRepresentation(boundsRef, &rect);

        // Get layer
        CFNumberRef layerRef = (CFNumberRef)CFDictionaryGetValue(win, kCGWindowLayer);
        int layer = 0;
        if (layerRef) CFNumberGetValue(layerRef, kCFNumberIntType, &layer);

        // Get title
        CFStringRef titleRef = (CFStringRef)CFDictionaryGetValue(win, kCGWindowName);

        // Get owner name
        CFStringRef ownerRef = (CFStringRef)CFDictionaryGetValue(win, kCGWindowOwnerName);

        auto obj = Napi::Object::New(env);
        obj.Set("pid", pid);
        obj.Set("cgWindowId", windowId);
        obj.Set("x", rect.origin.x);
        obj.Set("y", rect.origin.y);
        obj.Set("w", rect.size.width);
        obj.Set("h", rect.size.height);
        obj.Set("layer", layer);
        if (titleRef) obj.Set("title", cfToStd(titleRef));
        if (ownerRef) obj.Set("owner", cfToStd(ownerRef));

        result.Set(idx++, obj);
    }
    CFRelease(windowList);
    return result;
}

// ─── CMD+Tab App Switch ─────────────────────────────────────────────────────

// axSwitchApp(name: string): { ok: bool, activated: string, bundleId: string, pid: number, tabsPressed: number }
// Simulates the visible CMD+Tab switcher to switch to the named app.
static Napi::Value AxSwitchApp(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 1 || !info[0].IsString()) {
        Napi::TypeError::New(env, "Expected app name (string)").ThrowAsJavaScriptException();
        return env.Null();
    }

    std::string appQuery = info[0].As<Napi::String>().Utf8Value();
    NSString* query = [NSString stringWithUTF8String:appQuery.c_str()];

    RunningAppInfo target;
    if (!findWorkspaceRunningAppMatching(query, target)) {
        auto result = Napi::Object::New(env);
        result.Set("ok", false);
        result.Set("error", std::string("No running app matching '") + appQuery + "'");
        return result;
    }

    std::string targetName = !target.name.empty() ? target.name : (!target.bundleId.empty() ? target.bundleId : appQuery);
    std::string bundleId = target.bundleId;
    pid_t targetPid = target.pid;

    // Already frontmost — no-op
    FrontmostAppInfo front = getWorkspaceFrontmostAppInfo(true);
    if (front.valid && front.pid == targetPid) {
        auto result = Napi::Object::New(env);
        result.Set("ok", true);
        result.Set("activated", targetName);
        result.Set("bundleId", bundleId);
        result.Set("pid", (double)targetPid);
        result.Set("tabsPressed", 0);
        return result;
    }

    bool activationRequested = activateWorkspaceApp(targetPid);
    int tabsPressed = 0;
    if (!activationRequested) {
        auto result = Napi::Object::New(env);
        result.Set("ok", false);
        result.Set("error", std::string("Failed to activate '") + targetName + "'");
        return result;
    }

    // Wait for activation to complete — retry for up to 2s until the frontmost app changes.
    bool success = false;
    for (int attempt = 0; attempt < 20; attempt++) {
        usleep(100000);  // 100ms per attempt
        FrontmostAppInfo nowFront = getWorkspaceFrontmostAppInfo(true);
        if (nowFront.valid && nowFront.pid == targetPid) {
            success = true;
            break;
        }
    }

    auto result = Napi::Object::New(env);
    result.Set("ok", success);
    result.Set("activated", targetName);
    result.Set("bundleId", bundleId);
    result.Set("pid", (double)targetPid);
    result.Set("tabsPressed", tabsPressed);
    return result;
}

// ─── Keyboard Input ─────────────────────────────────────────────────────────

// Key name → macOS virtual key code mapping
static CGKeyCode virtualKeyCodeForName(const std::string& name) {
    // Special keys
    if (name == "return" || name == "enter") return 0x24;
    if (name == "tab") return 0x30;
    if (name == "space") return 0x31;
    if (name == "delete" || name == "backspace") return 0x33;
    if (name == "escape" || name == "esc") return 0x35;
    if (name == "left") return 0x7B;
    if (name == "right") return 0x7C;
    if (name == "down") return 0x7D;
    if (name == "up") return 0x7E;
    if (name == "home") return 0x73;
    if (name == "end") return 0x77;
    if (name == "pageup") return 0x74;
    if (name == "pagedown") return 0x79;
    if (name == "forwarddelete") return 0x75;
    // Function keys
    if (name == "f1") return 0x7A;
    if (name == "f2") return 0x78;
    if (name == "f3") return 0x63;
    if (name == "f4") return 0x76;
    if (name == "f5") return 0x60;
    if (name == "f6") return 0x61;
    if (name == "f7") return 0x62;
    if (name == "f8") return 0x64;
    if (name == "f9") return 0x65;
    if (name == "f10") return 0x6D;
    if (name == "f11") return 0x67;
    if (name == "f12") return 0x6F;
    // Letters a-z
    static const CGKeyCode letterCodes[26] = {
        0x00,0x0B,0x08,0x02,0x0E,0x03,0x05,0x04,0x22,0x26,
        0x28,0x25,0x2E,0x2D,0x1F,0x23,0x0C,0x0F,0x01,0x11,
        0x20,0x09,0x0D,0x07,0x10,0x06
    };
    if (name.length() == 1 && name[0] >= 'a' && name[0] <= 'z') {
        return letterCodes[name[0] - 'a'];
    }
    return 0xFFFF; // sentinel for "not found"
}

static CGEventFlags parseModifierFlags(const std::vector<std::string>& modifiers) {
    CGEventFlags flags = (CGEventFlags)0;
    for (auto& mod : modifiers) {
        if (mod == "command" || mod == "cmd") flags = (CGEventFlags)(flags | kCGEventFlagMaskCommand);
        else if (mod == "shift") flags = (CGEventFlags)(flags | kCGEventFlagMaskShift);
        else if (mod == "option" || mod == "alt") flags = (CGEventFlags)(flags | kCGEventFlagMaskAlternate);
        else if (mod == "control" || mod == "ctrl") flags = (CGEventFlags)(flags | kCGEventFlagMaskControl);
    }
    return flags;
}

// axPostKeyboardInput({ keys?: string[], modifiers?: string[], text?: string, rate?: number }): void
static Napi::Value AxPostKeyboardInput(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 1 || !info[0].IsObject()) {
        Napi::TypeError::New(env, "Expected options object").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    auto opts = info[0].As<Napi::Object>();
    CGEventSourceRef eventSource = CGEventSourceCreate(kCGEventSourceStateCombinedSessionState);

    // Parse modifiers
    std::vector<std::string> modifiers;
    if (opts.Has("modifiers") && opts.Get("modifiers").IsArray()) {
        auto modArr = opts.Get("modifiers").As<Napi::Array>();
        for (uint32_t i = 0; i < modArr.Length(); i++) {
            modifiers.push_back(modArr.Get(i).As<Napi::String>().Utf8Value());
        }
    }
    CGEventFlags modFlags = parseModifierFlags(modifiers);

    // Parse rate (ms between keystrokes)
    uint32_t delayUs = 0;
    if (opts.Has("rate") && opts.Get("rate").IsNumber()) {
        delayUs = opts.Get("rate").As<Napi::Number>().Uint32Value() * 1000;
    }

    if (opts.Has("text") && opts.Get("text").IsString()) {
        // Text typing mode — post Unicode characters
        std::string text = opts.Get("text").As<Napi::String>().Utf8Value();
        NSString* nsText = [NSString stringWithUTF8String:text.c_str()];

        for (NSUInteger i = 0; i < nsText.length; i++) {
            unichar ch = [nsText characterAtIndex:i];
            UniChar uc = (UniChar)ch;

            CGEventRef down = CGEventCreateKeyboardEvent(eventSource, 0, true);
            CGEventRef up = CGEventCreateKeyboardEvent(eventSource, 0, false);
            if (!down || !up) {
                if (down) CFRelease(down);
                if (up) CFRelease(up);
                if (eventSource) CFRelease(eventSource);
                Napi::Error::New(env, "Cannot create CGEvent — accessibility permission?").ThrowAsJavaScriptException();
                return env.Undefined();
            }

            CGEventKeyboardSetUnicodeString(down, 1, &uc);
            CGEventKeyboardSetUnicodeString(up, 1, &uc);
            CGEventSetFlags(down, modFlags);
            CGEventSetFlags(up, modFlags);
            CGEventPost(kCGSessionEventTap, down);
            CGEventPost(kCGSessionEventTap, up);
            CFRelease(down);
            CFRelease(up);

            if (delayUs > 0) usleep(delayUs);
        }
    } else if (opts.Has("keys") && opts.Get("keys").IsArray()) {
        // Named key mode — post key codes
        auto keysArr = opts.Get("keys").As<Napi::Array>();
        for (uint32_t i = 0; i < keysArr.Length(); i++) {
            std::string keyName = keysArr.Get(i).As<Napi::String>().Utf8Value();
            // Lowercase for matching
            std::transform(keyName.begin(), keyName.end(), keyName.begin(), ::tolower);

            CGKeyCode keyCode = virtualKeyCodeForName(keyName);
            if (keyCode == 0xFFFF) {
                if (eventSource) CFRelease(eventSource);
                Napi::Error::New(env, std::string("Unknown key name: '") + keyName + "'").ThrowAsJavaScriptException();
                return env.Undefined();
            }

            CGEventRef down = CGEventCreateKeyboardEvent(eventSource, keyCode, true);
            CGEventRef up = CGEventCreateKeyboardEvent(eventSource, keyCode, false);
            if (!down || !up) {
                if (down) CFRelease(down);
                if (up) CFRelease(up);
                if (eventSource) CFRelease(eventSource);
                Napi::Error::New(env, "Cannot create CGEvent — accessibility permission?").ThrowAsJavaScriptException();
                return env.Undefined();
            }

            CGEventSetFlags(down, modFlags);
            CGEventSetFlags(up, modFlags);
            CGEventPost(kCGSessionEventTap, down);
            CGEventPost(kCGSessionEventTap, up);
            CFRelease(down);
            CFRelease(up);

            if (delayUs > 0) usleep(delayUs);
        }
    } else {
        if (eventSource) CFRelease(eventSource);
        Napi::Error::New(env, "Must provide 'text' or 'keys'").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    if (eventSource) CFRelease(eventSource);
    return env.Undefined();
}

// ─── Overlay Notification ───────────────────────────────────────────────────

// axPostOverlay(type: string, payload: object): void
// Posts an NSDistributedNotification to trigger overlays in the GhostUI Swift app.
static Napi::Value AxPostOverlay(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 2 || !info[0].IsString() || !info[1].IsString()) {
        Napi::TypeError::New(env, "Expected (type: string, jsonPayload: string)").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    std::string type = info[0].As<Napi::String>().Utf8Value();
    std::string jsonPayload = info[1].As<Napi::String>().Utf8Value();

    NSString* notifName = [NSString stringWithFormat:@"org.ghostvm.GhostUI.overlay.%s", type.c_str()];
    NSString* payload = [NSString stringWithUTF8String:jsonPayload.c_str()];

    [[NSDistributedNotificationCenter defaultCenter]
        postNotificationName:notifName
        object:nil
        userInfo:@{@"payload": payload}
        deliverImmediately:YES];

    return env.Undefined();
}

// ─── Pointer Events ─────────────────────────────────────────────────────────

// axPointerEvent({ action, x, y, button?, endX?, endY?, deltaX?, deltaY? }): { ok: bool }
// Posts CGEvent mouse events: click, doubleClick, rightClick, middleClick, move, drag, scroll
static Napi::Value AxPointerEvent(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 1 || !info[0].IsObject()) {
        Napi::TypeError::New(env, "Expected options object").ThrowAsJavaScriptException();
        return env.Null();
    }

    auto opts = info[0].As<Napi::Object>();
    if (!opts.Has("action") || !opts.Get("action").IsString()) {
        Napi::TypeError::New(env, "Expected 'action' string").ThrowAsJavaScriptException();
        return env.Null();
    }

    std::string action = opts.Get("action").As<Napi::String>().Utf8Value();
    double x = opts.Has("x") && opts.Get("x").IsNumber() ? opts.Get("x").As<Napi::Number>().DoubleValue() : 0;
    double y = opts.Has("y") && opts.Get("y").IsNumber() ? opts.Get("y").As<Napi::Number>().DoubleValue() : 0;

    CGEventSourceRef eventSource = CGEventSourceCreate(kCGEventSourceStateCombinedSessionState);
    CGPoint point = CGPointMake(x, y);

    auto postClick = [&](CGMouseButton button) {
        CGEventType downType, upType;
        switch (button) {
            case kCGMouseButtonLeft:   downType = kCGEventLeftMouseDown;  upType = kCGEventLeftMouseUp;  break;
            case kCGMouseButtonRight:  downType = kCGEventRightMouseDown; upType = kCGEventRightMouseUp; break;
            default:                   downType = kCGEventOtherMouseDown; upType = kCGEventOtherMouseUp; break;
        }
        CGEventRef down = CGEventCreateMouseEvent(eventSource, downType, point, button);
        CGEventRef up = CGEventCreateMouseEvent(eventSource, upType, point, button);
        if (down && up) {
            CGEventPost(kCGSessionEventTap, down);
            usleep(10000);
            CGEventPost(kCGSessionEventTap, up);
        }
        if (down) CFRelease(down);
        if (up) CFRelease(up);
    };

    auto postMove = [&](CGPoint p) {
        CGEventRef move = CGEventCreateMouseEvent(eventSource, kCGEventMouseMoved, p, kCGMouseButtonLeft);
        if (move) {
            CGEventPost(kCGSessionEventTap, move);
            CFRelease(move);
        }
    };

    bool ok = true;

    if (action == "click") {
        postMove(point);
        usleep(50000);
        postClick(kCGMouseButtonLeft);
    } else if (action == "doubleClick") {
        postMove(point);
        usleep(50000);
        CGEventRef down1 = CGEventCreateMouseEvent(eventSource, kCGEventLeftMouseDown, point, kCGMouseButtonLeft);
        CGEventRef up1 = CGEventCreateMouseEvent(eventSource, kCGEventLeftMouseUp, point, kCGMouseButtonLeft);
        CGEventRef down2 = CGEventCreateMouseEvent(eventSource, kCGEventLeftMouseDown, point, kCGMouseButtonLeft);
        CGEventRef up2 = CGEventCreateMouseEvent(eventSource, kCGEventLeftMouseUp, point, kCGMouseButtonLeft);
        if (down1 && up1 && down2 && up2) {
            CGEventSetIntegerValueField(down1, kCGMouseEventClickState, 1);
            CGEventSetIntegerValueField(up1, kCGMouseEventClickState, 1);
            CGEventPost(kCGSessionEventTap, down1);
            usleep(10000);
            CGEventPost(kCGSessionEventTap, up1);
            usleep(50000);
            CGEventSetIntegerValueField(down2, kCGMouseEventClickState, 2);
            CGEventSetIntegerValueField(up2, kCGMouseEventClickState, 2);
            CGEventPost(kCGSessionEventTap, down2);
            usleep(10000);
            CGEventPost(kCGSessionEventTap, up2);
        }
        if (down1) CFRelease(down1);
        if (up1) CFRelease(up1);
        if (down2) CFRelease(down2);
        if (up2) CFRelease(up2);
    } else if (action == "rightClick") {
        postMove(point);
        usleep(50000);
        postClick(kCGMouseButtonRight);
    } else if (action == "middleClick") {
        postMove(point);
        usleep(50000);
        postClick(kCGMouseButtonCenter);
    } else if (action == "move") {
        postMove(point);
    } else if (action == "drag") {
        double endX = opts.Has("endX") && opts.Get("endX").IsNumber() ? opts.Get("endX").As<Napi::Number>().DoubleValue() : x;
        double endY = opts.Has("endY") && opts.Get("endY").IsNumber() ? opts.Get("endY").As<Napi::Number>().DoubleValue() : y;
        CGPoint endPoint = CGPointMake(endX, endY);

        postMove(point);
        usleep(50000);

        // Mouse down
        CGEventRef down = CGEventCreateMouseEvent(eventSource, kCGEventLeftMouseDown, point, kCGMouseButtonLeft);
        if (down) { CGEventPost(kCGSessionEventTap, down); CFRelease(down); }
        usleep(50000);

        // Interpolate drag steps
        int steps = 20;
        for (int i = 1; i <= steps; i++) {
            double t = (double)i / steps;
            CGPoint p = CGPointMake(x + (endX - x) * t, y + (endY - y) * t);
            CGEventRef drag = CGEventCreateMouseEvent(eventSource, kCGEventLeftMouseDragged, p, kCGMouseButtonLeft);
            if (drag) { CGEventPost(kCGSessionEventTap, drag); CFRelease(drag); }
            usleep(10000);
        }

        // Mouse up
        CGEventRef up = CGEventCreateMouseEvent(eventSource, kCGEventLeftMouseUp, endPoint, kCGMouseButtonLeft);
        if (up) { CGEventPost(kCGSessionEventTap, up); CFRelease(up); }
    } else if (action == "scroll") {
        int32_t deltaX = opts.Has("deltaX") && opts.Get("deltaX").IsNumber() ? opts.Get("deltaX").As<Napi::Number>().Int32Value() : 0;
        int32_t deltaY = opts.Has("deltaY") && opts.Get("deltaY").IsNumber() ? opts.Get("deltaY").As<Napi::Number>().Int32Value() : 0;

        postMove(point);
        usleep(50000);

        CGEventRef scroll = CGEventCreateScrollWheelEvent(eventSource, kCGScrollEventUnitLine, 2, deltaY, deltaX);
        if (scroll) {
            CGEventPost(kCGSessionEventTap, scroll);
            CFRelease(scroll);
        }
    } else {
        ok = false;
    }

    if (eventSource) CFRelease(eventSource);

    auto result = Napi::Object::New(env);
    result.Set("ok", ok);
    return result;
}

// ─── Screenshot ─────────────────────────────────────────────────────────────

// axScreenshot(format?: string): Buffer
// Captures the main display as PNG (default) or JPEG and returns as a Node.js Buffer.
static Napi::Value AxScreenshot(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    std::string format = "png";
    if (info.Length() > 0 && info[0].IsString()) {
        format = info[0].As<Napi::String>().Utf8Value();
    }

    CGImageRef cgImage = CGDisplayCreateImage(CGMainDisplayID());
    if (!cgImage) {
        Napi::Error::New(env, "Failed to capture screenshot — screen recording permission?").ThrowAsJavaScriptException();
        return env.Null();
    }

    NSBitmapImageRep* rep = [[NSBitmapImageRep alloc] initWithCGImage:cgImage];
    CGImageRelease(cgImage);

    NSData* data;
    if (format == "jpeg" || format == "jpg") {
        data = [rep representationUsingType:NSBitmapImageFileTypeJPEG
                                properties:@{NSImageCompressionFactor: @(0.8)}];
    } else {
        data = [rep representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
    }

    if (!data || data.length == 0) {
        Napi::Error::New(env, "Failed to encode screenshot").ThrowAsJavaScriptException();
        return env.Null();
    }

    auto buffer = Napi::Buffer<uint8_t>::Copy(env, (const uint8_t*)data.bytes, data.length);
    return buffer;
}

// keychainReadGenericPassword(service: string, account: string, accessGroup?: string): string | null
static Napi::Value KeychainReadGenericPassword(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 2 || !info[0].IsString() || !info[1].IsString()) {
        Napi::TypeError::New(env, "Expected (service: string, account: string, accessGroup?: string)")
            .ThrowAsJavaScriptException();
        return env.Null();
    }

    NSString* service = [NSString stringWithUTF8String:info[0].As<Napi::String>().Utf8Value().c_str()];
    NSString* account = [NSString stringWithUTF8String:info[1].As<Napi::String>().Utf8Value().c_str()];
    NSString* accessGroup = nil;
    if (info.Length() > 2 && info[2].IsString()) {
        accessGroup = [NSString stringWithUTF8String:info[2].As<Napi::String>().Utf8Value().c_str()];
    }

    NSMutableDictionary* query = [@{
        (__bridge id)kSecClass: (__bridge id)kSecClassGenericPassword,
        (__bridge id)kSecAttrService: service,
        (__bridge id)kSecAttrAccount: account,
        (__bridge id)kSecUseDataProtectionKeychain: @YES,
        (__bridge id)kSecReturnData: @YES,
        (__bridge id)kSecMatchLimit: (__bridge id)kSecMatchLimitOne,
    } mutableCopy];
    if (accessGroup && accessGroup.length > 0) {
        query[(__bridge id)kSecAttrAccessGroup] = accessGroup;
    }

    CFTypeRef result = NULL;
    OSStatus status = SecItemCopyMatching((__bridge CFDictionaryRef)query, &result);
    if (status == errSecItemNotFound) {
        return env.Null();
    }
    if (status != errSecSuccess) {
        Napi::Error::New(env, "SecItemCopyMatching failed: " + osStatusMessage(status))
            .ThrowAsJavaScriptException();
        return env.Null();
    }

    NSData* data = (__bridge_transfer NSData*)result;
    NSString* password = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
    if (!password || password.length == 0) {
        return env.Null();
    }
    return Napi::String::New(env, std::string([password UTF8String]));
}

// ─── AXObserver Infrastructure ──────────────────────────────────────────────

#include <mutex>
#include <unordered_map>
#include <vector>
#include <set>
#include <dispatch/dispatch.h>
#include <sys/time.h>

// Thread-safe function to call back into JS
static napi_threadsafe_function g_tsfn = nullptr;

// Observer thread's CFRunLoop (so we can add/remove sources from any thread)
static CFRunLoopRef g_observerRunLoop = nullptr;
static bool g_observerRunning = false;

// Per-PID observer state
struct AppObserver {
    AXObserverRef observer = nullptr;
    pid_t pid = 0;
    std::string bundleId;
    // Element refs we've registered notifications on (for cleanup)
    std::vector<AXUIElementRef> registeredElements;
};

static std::mutex g_observerMutex;
static std::unordered_map<pid_t, AppObserver> g_appObservers;

// Element observers with TTL (Iteration 3)
struct ElementObserver {
    AXUIElementRef element;
    pid_t pid;
    double registeredAt; // seconds since epoch
};
static std::mutex g_elementMutex;
static std::vector<ElementObserver> g_elementObservers;

// Focus-tracked elements per PID (Iteration 4)
static std::mutex g_focusMutex;
static std::unordered_map<pid_t, AXUIElementRef> g_focusedElements;

// Workspace notification tokens for app lifecycle / activation changes
static NSMutableArray* g_workspaceObserverTokens = nil;

static void observeApp(pid_t pid, const std::string& bundleId);
static void stopObservingApp(pid_t pid);
static void observeRunningApps();
static void cleanupExpiredElementObservers();

static void clearWorkspaceObservers() {
    if (!g_workspaceObserverTokens) return;
    NSNotificationCenter* center = [[NSWorkspace sharedWorkspace] notificationCenter];
    for (id token in g_workspaceObserverTokens) {
        [center removeObserver:token];
    }
    [g_workspaceObserverTokens removeAllObjects];
}

static double now_seconds() {
    struct timeval tv;
    gettimeofday(&tv, nullptr);
    return tv.tv_sec + tv.tv_usec / 1.0e6;
}

// Marshal an event to JS via the threadsafe function
struct AXEvent {
    std::string type;
    pid_t pid;
    std::string bundleId;
};

static void tsfn_callback(napi_env env, napi_value js_callback, void* context, void* data) {
    AXEvent* event = static_cast<AXEvent*>(data);
    if (!event || !env) { delete event; return; }

    napi_value obj;
    napi_create_object(env, &obj);

    napi_value type_val;
    napi_create_string_utf8(env, event->type.c_str(), event->type.size(), &type_val);
    napi_set_named_property(env, obj, "type", type_val);

    napi_value pid_val;
    napi_create_int32(env, event->pid, &pid_val);
    napi_set_named_property(env, obj, "pid", pid_val);

    napi_value bid_val;
    napi_create_string_utf8(env, event->bundleId.c_str(), event->bundleId.size(), &bid_val);
    napi_set_named_property(env, obj, "bundleId", bid_val);

    napi_value args[] = { obj };
    napi_call_function(env, obj, js_callback, 1, args, nullptr);

    delete event;
}

static void fireEvent(const std::string& type, pid_t pid, const std::string& bundleId = "") {
    if (!g_tsfn) return;
    AXEvent* event = new AXEvent{type, pid, bundleId};
    napi_status status = napi_call_threadsafe_function(g_tsfn, event, napi_tsfn_nonblocking);
    if (status != napi_ok) {
        delete event;
    }
}

// Resolve bundleId for a PID
static std::string bundleIdForPid(pid_t pid) {
    NSRunningApplication* app = [NSRunningApplication runningApplicationWithProcessIdentifier:pid];
    if (app && app.bundleIdentifier) {
        return std::string([app.bundleIdentifier UTF8String]);
    }
    return "";
}

// AXObserver callback — fires when any registered notification triggers
static void axObserverCallback(AXObserverRef observer, AXUIElementRef element,
                                CFStringRef notificationName, void* refcon) {
    pid_t pid = (pid_t)(intptr_t)refcon;
    std::string notif = cfToStd(notificationName);
    std::string bundleId;

    cleanupExpiredElementObservers();

    {
        std::lock_guard<std::mutex> lock(g_observerMutex);
        auto it = g_appObservers.find(pid);
        if (it != g_appObservers.end()) {
            bundleId = it->second.bundleId;
        }
    }

    // When a new window is created, register move/resize/title observers on it
    if (notif == "AXWindowCreated" && element) {
        std::lock_guard<std::mutex> lock(g_observerMutex);
        auto it = g_appObservers.find(pid);
        if (it != g_appObservers.end() && it->second.observer) {
            void* ref = (void*)(intptr_t)pid;
            AXObserverAddNotification(it->second.observer, element, kAXMovedNotification, ref);
            AXObserverAddNotification(it->second.observer, element, kAXResizedNotification, ref);
            AXObserverAddNotification(it->second.observer, element, kAXTitleChangedNotification, ref);
            CFRetain(element);
            it->second.registeredElements.push_back(element);
        }
    }

    // Map AX notification to event type
    std::string eventType;
    if (notif == "AXWindowCreated") eventType = "window-created";
    else if (notif == "AXUIElementDestroyed") eventType = "element-destroyed";
    else if (notif == "AXFocusedWindowChanged") eventType = "focused-window-changed";
    else if (notif == "AXMainWindowChanged") eventType = "main-window-changed";
    else if (notif == "AXMoved") eventType = "window-moved";
    else if (notif == "AXResized") eventType = "window-resized";
    else if (notif == "AXTitleChanged") eventType = "title-changed";
    else if (notif == "AXFocusedUIElementChanged") eventType = "focused-element-changed";
    else if (notif == "AXValueChanged") eventType = "value-changed";
    else if (notif == "AXSelectedChildrenChanged") eventType = "selected-children-changed";
    else if (notif == "AXLayoutChanged") eventType = "layout-changed";
    else if (notif == "AXSelectedTextChanged") eventType = "selected-text-changed";
    else if (notif == "AXApplicationActivated") eventType = "app-activated";
    else if (notif == "AXApplicationDeactivated") eventType = "app-deactivated";
    else eventType = notif; // pass through unknown

    // Handle focus change for Iteration 4: register value observers on text inputs
    if (notif == "AXFocusedUIElementChanged") {
        AXUIElementRef appEl = AXUIElementCreateApplication(pid);
        CFTypeRef focusedEl = NULL;
        AXError err = AXUIElementCopyAttributeValue(appEl, kAXFocusedUIElementAttribute, &focusedEl);
        if (err == kAXErrorSuccess && focusedEl) {
            std::string focusedRole = axGetString((AXUIElementRef)focusedEl, kAXRoleAttribute);
            bool isTextInput = (focusedRole == "AXTextField" || focusedRole == "AXTextArea" ||
                                focusedRole == "AXComboBox" || focusedRole == "AXSearchField");

            {
                std::lock_guard<std::mutex> lock(g_focusMutex);
                auto fit = g_focusedElements.find(pid);

                // Unregister from previous focused element
                if (fit != g_focusedElements.end()) {
                    auto oit = g_appObservers.find(pid);
                    if (oit != g_appObservers.end() && oit->second.observer) {
                        AXObserverRemoveNotification(oit->second.observer, fit->second, CFSTR("AXValueChanged"));
                        AXObserverRemoveNotification(oit->second.observer, fit->second, CFSTR("AXSelectedTextChanged"));
                    }
                    CFRelease(fit->second);
                    g_focusedElements.erase(fit);
                }

                // Register on new focused element if it's a text input
                if (isTextInput) {
                    std::lock_guard<std::mutex> olock(g_observerMutex);
                    auto oit = g_appObservers.find(pid);
                    if (oit != g_appObservers.end() && oit->second.observer) {
                        AXObserverAddNotification(oit->second.observer, (AXUIElementRef)focusedEl,
                                                   CFSTR("AXValueChanged"), (void*)(intptr_t)pid);
                        AXObserverAddNotification(oit->second.observer, (AXUIElementRef)focusedEl,
                                                   CFSTR("AXSelectedTextChanged"), (void*)(intptr_t)pid);
                        CFRetain(focusedEl);
                        g_focusedElements[pid] = (AXUIElementRef)focusedEl;
                    }
                }
            }
            CFRelease(focusedEl);
        }
        CFRelease(appEl);
    }

    // app-activated is the canonical "this app is now foreground" event.
    // Fire as focused-app-changed and suppress the raw app-activated.
    if (notif == "AXApplicationActivated") {
        if (pid != g_lastFrontPid && pid > 0) {
            g_lastFrontPid = pid;
            fireEvent("focused-app-changed", pid, bundleId);
        }
        return; // don't also fire app-activated
    }

    // Suppress app-deactivated — redundant with focused-app-changed
    if (notif == "AXApplicationDeactivated") return;

    fireEvent(eventType, pid, bundleId);
}

// Register AXObserver on a single app PID
static void observeApp(pid_t pid, const std::string& bundleId) {
    if (!g_observerRunLoop) return;

    {
        std::lock_guard<std::mutex> lock(g_observerMutex);
        if (g_appObservers.count(pid)) return; // already observing
    }

    AXObserverRef observer = nullptr;
    AXError err = AXObserverCreate(pid, axObserverCallback, &observer);
    if (err != kAXErrorSuccess || !observer) return;

    AXUIElementRef appEl = AXUIElementCreateApplication(pid);

    // App-level notifications
    CFStringRef appNotifs[] = {
        kAXWindowCreatedNotification,
        kAXUIElementDestroyedNotification,
        kAXFocusedWindowChangedNotification,
        kAXMainWindowChangedNotification,
        CFSTR("AXFocusedUIElementChanged"),
        kAXApplicationActivatedNotification,
        kAXApplicationDeactivatedNotification,
    };

    void* refcon = (void*)(intptr_t)pid;
    for (auto notif : appNotifs) {
        AXObserverAddNotification(observer, appEl, notif, refcon);
    }

    // Register on existing windows for move/resize/title
    CFTypeRef windowsVal = NULL;
    AXError wErr = AXUIElementCopyAttributeValue(appEl, kAXWindowsAttribute, &windowsVal);
    std::vector<AXUIElementRef> registeredEls;
    if (wErr == kAXErrorSuccess && windowsVal && CFGetTypeID(windowsVal) == CFArrayGetTypeID()) {
        CFArrayRef windows = (CFArrayRef)windowsVal;
        for (CFIndex i = 0; i < CFArrayGetCount(windows); i++) {
            AXUIElementRef win = (AXUIElementRef)CFArrayGetValueAtIndex(windows, i);
            AXObserverAddNotification(observer, win, kAXMovedNotification, refcon);
            AXObserverAddNotification(observer, win, kAXResizedNotification, refcon);
            AXObserverAddNotification(observer, win, kAXTitleChangedNotification, refcon);
            CFRetain(win);
            registeredEls.push_back(win);
        }
        CFRelease(windowsVal);
    }

    // Add observer's run loop source to our background run loop
    CFRunLoopSourceRef source = AXObserverGetRunLoopSource(observer);
    CFRunLoopAddSource(g_observerRunLoop, source, kCFRunLoopDefaultMode);
    CFRunLoopWakeUp(g_observerRunLoop);

    {
        std::lock_guard<std::mutex> lock(g_observerMutex);
        AppObserver ao;
        ao.observer = observer;
        ao.pid = pid;
        ao.bundleId = bundleId;
        ao.registeredElements = std::move(registeredEls);
        g_appObservers[pid] = std::move(ao);
    }

    CFRelease(appEl);
}

// Stop observing a single app PID
static void stopObservingApp(pid_t pid) {
    std::lock_guard<std::mutex> lock(g_observerMutex);
    auto it = g_appObservers.find(pid);
    if (it == g_appObservers.end()) return;

    AppObserver& ao = it->second;
    if (ao.observer && g_observerRunLoop) {
        CFRunLoopSourceRef source = AXObserverGetRunLoopSource(ao.observer);
        CFRunLoopRemoveSource(g_observerRunLoop, source, kCFRunLoopDefaultMode);
        CFRelease(ao.observer);
    }
    for (auto el : ao.registeredElements) {
        CFRelease(el);
    }

    // Clean up focus-tracked element for this PID
    {
        std::lock_guard<std::mutex> flock(g_focusMutex);
        auto fit = g_focusedElements.find(pid);
        if (fit != g_focusedElements.end()) {
            CFRelease(fit->second);
            g_focusedElements.erase(fit);
        }
    }

    g_appObservers.erase(it);
}

// Seed observers for the apps that are already running when monitoring starts.
static void observeRunningApps() {
    @autoreleasepool {
        NSArray<NSRunningApplication*>* apps = [[NSWorkspace sharedWorkspace] runningApplications];
        for (NSRunningApplication* app in apps) {
            if (app.activationPolicy != NSApplicationActivationPolicyRegular) continue;
            pid_t pid = app.processIdentifier;
            std::string bid = app.bundleIdentifier ? std::string([app.bundleIdentifier UTF8String]) : "";
            observeApp(pid, bid);
        }
    }
}

// CGEventTap callback for Iteration 3 (click-driven element observers)
static CGEventRef eventTapCallback(CGEventTapProxy proxy, CGEventType type,
                                     CGEventRef event, void* refcon) {
    if (type == kCGEventLeftMouseDown) {
        CGPoint loc = CGEventGetLocation(event);
        // Resolve element at click point on observer thread to avoid blocking
        dispatch_async(dispatch_get_global_queue(DISPATCH_QUEUE_PRIORITY_DEFAULT, 0), ^{
            cleanupExpiredElementObservers();
            AXUIElementRef systemWide = AXUIElementCreateSystemWide();
            AXUIElementRef element = NULL;
            AXError err = AXUIElementCopyElementAtPosition(systemWide, (float)loc.x, (float)loc.y, &element);
            if (err == kAXErrorSuccess && element) {
                pid_t elPid = 0;
                AXUIElementGetPid(element, &elPid);

                // Walk up ancestors (max 5 levels), register element observers
                AXUIElementRef current = element;
                CFRetain(current);
                double timestamp = now_seconds();

                for (int level = 0; level < 5 && current; level++) {
                    // Find this PID's observer
                    {
                        std::lock_guard<std::mutex> lock(g_observerMutex);
                        auto it = g_appObservers.find(elPid);
                        if (it != g_appObservers.end() && it->second.observer) {
                            void* refcon = (void*)(intptr_t)elPid;
                            AXObserverAddNotification(it->second.observer, current,
                                                       CFSTR("AXValueChanged"), refcon);
                            AXObserverAddNotification(it->second.observer, current,
                                                       CFSTR("AXSelectedChildrenChanged"), refcon);
                            AXObserverAddNotification(it->second.observer, current,
                                                       CFSTR("AXLayoutChanged"), refcon);
                        }
                    }

                    {
                        std::lock_guard<std::mutex> elock(g_elementMutex);
                        CFRetain(current);
                        g_elementObservers.push_back({current, elPid, timestamp});
                    }

                    // Walk up to parent
                    CFTypeRef parentVal = NULL;
                    AXError pErr = AXUIElementCopyAttributeValue(current, kAXParentAttribute, &parentVal);
                    CFRelease(current);
                    if (pErr == kAXErrorSuccess && parentVal) {
                        current = (AXUIElementRef)parentVal;
                    } else {
                        current = NULL;
                    }
                }
                if (current) CFRelease(current);

                fireEvent("element-changed", elPid, bundleIdForPid(elPid));
                CFRelease(element);
            }
            CFRelease(systemWide);
        });
    }
    return event; // pass-through (listenOnly)
}

// Event-driven cleanup for expired element observers (TTL = 3 seconds).
// We call this from AX event paths so we stay fully event-triggered without
// a periodic sweep timer.
static void cleanupExpiredElementObservers() {
    double cutoff = now_seconds() - 3.0;
    std::lock_guard<std::mutex> elock(g_elementMutex);
    std::lock_guard<std::mutex> olock(g_observerMutex);

    auto it = g_elementObservers.begin();
    while (it != g_elementObservers.end()) {
        if (it->registeredAt < cutoff) {
            // Unregister notifications
            auto oit = g_appObservers.find(it->pid);
            if (oit != g_appObservers.end() && oit->second.observer) {
                AXObserverRemoveNotification(oit->second.observer, it->element, CFSTR("AXValueChanged"));
                AXObserverRemoveNotification(oit->second.observer, it->element, CFSTR("AXSelectedChildrenChanged"));
                AXObserverRemoveNotification(oit->second.observer, it->element, CFSTR("AXLayoutChanged"));
            }
            CFRelease(it->element);
            it = g_elementObservers.erase(it);
        } else {
            ++it;
        }
    }
}

// Observer thread entry point
static void observerThreadMain() {
    @autoreleasepool {
        g_observerRunLoop = CFRunLoopGetCurrent();

        // Add a dummy source so the run loop doesn't exit immediately
        CFRunLoopSourceContext ctx = {0};
        CFRunLoopSourceRef dummySource = CFRunLoopSourceCreate(NULL, 0, &ctx);
        CFRunLoopAddSource(g_observerRunLoop, dummySource, kCFRunLoopDefaultMode);

        // App lifecycle and activation are driven by NSWorkspace notifications.
        clearWorkspaceObservers();
        g_workspaceObserverTokens = [[NSMutableArray alloc] init];
        NSNotificationCenter* center = [[NSWorkspace sharedWorkspace] notificationCenter];

        id launchToken = [center
            addObserverForName:NSWorkspaceDidLaunchApplicationNotification
                        object:nil
                         queue:nil
                    usingBlock:^(NSNotification* note) {
                        @autoreleasepool {
                            NSRunningApplication* app = note.userInfo[NSWorkspaceApplicationKey];
                            if (!app || app.activationPolicy != NSApplicationActivationPolicyRegular) return;
                            pid_t pid = app.processIdentifier;
                            std::string bid = app.bundleIdentifier ? std::string([app.bundleIdentifier UTF8String]) : "";
                            observeApp(pid, bid);
                            fireEvent("app-launched", pid, bid);
                        }
                    }];
        if (launchToken) [g_workspaceObserverTokens addObject:launchToken];

        id terminateToken = [center
            addObserverForName:NSWorkspaceDidTerminateApplicationNotification
                        object:nil
                         queue:nil
                    usingBlock:^(NSNotification* note) {
                        @autoreleasepool {
                            NSRunningApplication* app = note.userInfo[NSWorkspaceApplicationKey];
                            if (!app) return;
                            pid_t pid = app.processIdentifier;
                            std::string bid = app.bundleIdentifier ? std::string([app.bundleIdentifier UTF8String]) : "";
                            stopObservingApp(pid);
                            fireEvent("app-terminated", pid, bid);
                        }
                    }];
        if (terminateToken) [g_workspaceObserverTokens addObject:terminateToken];

        id activateToken = [center
            addObserverForName:NSWorkspaceDidActivateApplicationNotification
                        object:nil
                         queue:nil
                    usingBlock:^(NSNotification* note) {
                        @autoreleasepool {
                            NSRunningApplication* app = note.userInfo[NSWorkspaceApplicationKey];
                            if (!app || app.activationPolicy != NSApplicationActivationPolicyRegular) return;
                            pid_t pid = app.processIdentifier;
                            std::string bid = app.bundleIdentifier ? std::string([app.bundleIdentifier UTF8String]) : "";
                            observeApp(pid, bid);
                            if (pid > 0 && pid != g_lastFrontPid) {
                                g_lastFrontPid = pid;
                                fireEvent("focused-app-changed", pid, bid);
                            }
                        }
                    }];
        if (activateToken) [g_workspaceObserverTokens addObject:activateToken];

        // CGEventTap for mouse clicks (Iteration 3)
        CGEventMask eventMask = (1 << kCGEventLeftMouseDown);
        CFMachPortRef eventTap = CGEventTapCreate(
            kCGSessionEventTap, kCGHeadInsertEventTap, kCGEventTapOptionListenOnly,
            eventMask, eventTapCallback, NULL);
        if (eventTap) {
            CFRunLoopSourceRef tapSource = CFMachPortCreateRunLoopSource(NULL, eventTap, 0);
            CFRunLoopAddSource(g_observerRunLoop, tapSource, kCFRunLoopDefaultMode);
            CFRelease(tapSource);
        }

        g_observerRunning = true;
        CFRunLoopRun();
        g_observerRunning = false;

        // Cleanup
        CFRunLoopRemoveSource(g_observerRunLoop, dummySource, kCFRunLoopDefaultMode);
        CFRelease(dummySource);
        if (eventTap) {
            CFMachPortInvalidate(eventTap);
            CFRelease(eventTap);
        }
        clearWorkspaceObservers();
        g_workspaceObserverTokens = nil;
        g_observerRunLoop = nullptr;
    }
}

// axStartObserving(callback) — starts observer thread and registers all running apps
static Napi::Value AxStartObserving(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 1 || !info[0].IsFunction()) {
        Napi::TypeError::New(env, "axStartObserving requires a callback function").ThrowAsJavaScriptException();
        return env.Null();
    }

    // Clean up previous tsfn if any
    if (g_tsfn) {
        napi_release_threadsafe_function(g_tsfn, napi_tsfn_release);
        g_tsfn = nullptr;
    }

    napi_value callback = info[0];
    napi_status status = napi_create_threadsafe_function(
        env, callback, nullptr,
        napi_value(Napi::String::New(env, "AXObserverCallback")),
        0, 1, nullptr, nullptr, nullptr, tsfn_callback, &g_tsfn);

    if (status != napi_ok) {
        Napi::Error::New(env, "Failed to create threadsafe function").ThrowAsJavaScriptException();
        return env.Null();
    }

    // Unref so this doesn't keep the process alive
    napi_unref_threadsafe_function(env, g_tsfn);

    // Start observer thread
    dispatch_async(dispatch_get_global_queue(DISPATCH_QUEUE_PRIORITY_DEFAULT, 0), ^{
        observerThreadMain();
    });

    // Wait briefly for run loop to start, then observe the apps already running.
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(100 * NSEC_PER_MSEC)),
                   dispatch_get_global_queue(DISPATCH_QUEUE_PRIORITY_DEFAULT, 0), ^{
        observeRunningApps();
    });

    return Napi::Boolean::New(env, true);
}

// axStopObserving() — stop the observer thread and clean up
static Napi::Value AxStopObserving(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    // Stop all app observers
    {
        std::lock_guard<std::mutex> lock(g_observerMutex);
        for (auto& [pid, ao] : g_appObservers) {
            if (ao.observer && g_observerRunLoop) {
                CFRunLoopSourceRef source = AXObserverGetRunLoopSource(ao.observer);
                CFRunLoopRemoveSource(g_observerRunLoop, source, kCFRunLoopDefaultMode);
                CFRelease(ao.observer);
            }
            for (auto el : ao.registeredElements) {
                CFRelease(el);
            }
        }
        g_appObservers.clear();
    }

    // Clean up element observers
    {
        std::lock_guard<std::mutex> lock(g_elementMutex);
        for (auto& eo : g_elementObservers) {
            CFRelease(eo.element);
        }
        g_elementObservers.clear();
    }

    // Clean up focus-tracked elements
    {
        std::lock_guard<std::mutex> lock(g_focusMutex);
        for (auto& [pid, el] : g_focusedElements) {
            CFRelease(el);
        }
        g_focusedElements.clear();
    }

    // Stop the run loop
    if (g_observerRunLoop) {
        CFRunLoopStop(g_observerRunLoop);
    }

    // Release the threadsafe function
    if (g_tsfn) {
        napi_release_threadsafe_function(g_tsfn, napi_tsfn_release);
        g_tsfn = nullptr;
    }

    return Napi::Boolean::New(env, true);
}

struct AXObserverBenchmarkTarget {
    AXUIElementRef element = nullptr;
    std::vector<CFStringRef> notifications;
};

static const char* axErrorName(AXError err) {
    switch (err) {
        case kAXErrorSuccess: return "success";
        case kAXErrorFailure: return "failure";
        case kAXErrorIllegalArgument: return "illegal-argument";
        case kAXErrorInvalidUIElement: return "invalid-ui-element";
        case kAXErrorInvalidUIElementObserver: return "invalid-ui-element-observer";
        case kAXErrorCannotComplete: return "cannot-complete";
        case kAXErrorAttributeUnsupported: return "attribute-unsupported";
        case kAXErrorActionUnsupported: return "action-unsupported";
        case kAXErrorNotificationUnsupported: return "notification-unsupported";
        case kAXErrorNotImplemented: return "not-implemented";
        case kAXErrorNotificationAlreadyRegistered: return "notification-already-registered";
        case kAXErrorNotificationNotRegistered: return "notification-not-registered";
        case kAXErrorAPIDisabled: return "api-disabled";
        case kAXErrorNoValue: return "no-value";
        case kAXErrorParameterizedAttributeUnsupported: return "parameterized-attribute-unsupported";
        case kAXErrorNotEnoughPrecision: return "not-enough-precision";
        default: return "unknown";
    }
}

static void recordAxFailure(std::unordered_map<std::string, uint32_t>& failuresByCode, AXError err) {
    std::string key = std::string(axErrorName(err)) + ":" + std::to_string((int)err);
    failuresByCode[key] += 1;
}

static void axObserverBenchmarkCallback(AXObserverRef observer,
                                        AXUIElementRef element,
                                        CFStringRef notificationName,
                                        void* refcon) {
    (void)observer;
    (void)element;
    (void)notificationName;
    (void)refcon;
}

// axBenchmarkObserverNotifications({ pid, iterations?, mode? })
// Measures native AXObserver create/add/remove costs without touching the live daemon observer state.
static Napi::Value AxBenchmarkObserverNotifications(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsObject()) {
        Napi::TypeError::New(env, "Expected options object").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    Napi::Object opts = info[0].As<Napi::Object>();
    if (!opts.Has("pid") || !opts.Get("pid").IsNumber()) {
        Napi::TypeError::New(env, "Expected numeric pid").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    pid_t pid = (pid_t)opts.Get("pid").As<Napi::Number>().Int32Value();
    if (pid <= 0) {
        Napi::TypeError::New(env, "pid must be > 0").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    if (!processExists(pid)) {
        Napi::Error::New(env, "pid does not exist").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    uint32_t iterations = 100;
    if (opts.Has("iterations") && opts.Get("iterations").IsNumber()) {
        double rawIterations = opts.Get("iterations").As<Napi::Number>().DoubleValue();
        if (rawIterations > 10000.0) rawIterations = 10000.0;
        if (rawIterations < 1.0) rawIterations = 1.0;
        iterations = (uint32_t)rawIterations;
    }

    std::string mode = "app";
    if (opts.Has("mode") && opts.Get("mode").IsString()) {
        mode = opts.Get("mode").As<Napi::String>().Utf8Value();
    }

    AXUIElementRef appEl = AXUIElementCreateApplication(pid);
    if (!appEl) {
        Napi::Error::New(env, "Failed to create AX application element").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    std::vector<AXObserverBenchmarkTarget> targets;
    std::vector<AXUIElementRef> ownedRefs;

    if (mode == "app") {
        targets.push_back({
            appEl,
            {
                kAXWindowCreatedNotification,
                kAXUIElementDestroyedNotification,
                kAXFocusedWindowChangedNotification,
                kAXMainWindowChangedNotification,
                CFSTR("AXFocusedUIElementChanged"),
                kAXApplicationActivatedNotification,
                kAXApplicationDeactivatedNotification,
            }
        });
    } else if (mode == "windows") {
        CFTypeRef windowsVal = nullptr;
        AXError wErr = AXUIElementCopyAttributeValue(appEl, kAXWindowsAttribute, &windowsVal);
        if (wErr == kAXErrorSuccess && windowsVal && CFGetTypeID(windowsVal) == CFArrayGetTypeID()) {
            CFArrayRef windows = (CFArrayRef)windowsVal;
            CFIndex count = CFArrayGetCount(windows);
            targets.reserve((size_t)count);
            for (CFIndex i = 0; i < count; i++) {
                AXUIElementRef win = (AXUIElementRef)CFArrayGetValueAtIndex(windows, i);
                if (!win) continue;
                CFRetain(win);
                ownedRefs.push_back(win);
                targets.push_back({
                    win,
                    { kAXMovedNotification, kAXResizedNotification, kAXTitleChangedNotification }
                });
            }
        }
        if (windowsVal) CFRelease(windowsVal);
    } else if (mode == "focused") {
        CFTypeRef focusedVal = nullptr;
        AXError fErr = AXUIElementCopyAttributeValue(appEl, kAXFocusedUIElementAttribute, &focusedVal);
        if (fErr == kAXErrorSuccess && focusedVal) {
            AXUIElementRef focusedEl = (AXUIElementRef)focusedVal;
            std::string role = axGetString(focusedEl, kAXRoleAttribute);
            bool isTextInput = (role == "AXTextField" || role == "AXTextArea" ||
                                role == "AXComboBox" || role == "AXSearchField");
            if (isTextInput) {
                ownedRefs.push_back(focusedEl);
                targets.push_back({
                    focusedEl,
                    { CFSTR("AXValueChanged"), CFSTR("AXSelectedTextChanged") }
                });
            } else {
                CFRelease(focusedEl);
            }
        }
    } else {
        CFRelease(appEl);
        Napi::TypeError::New(env, "mode must be one of: app, windows, focused").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    using Clock = std::chrono::steady_clock;
    double createObserverMs = 0.0;
    double addNotificationsMs = 0.0;
    double removeNotificationsMs = 0.0;
    uint32_t totalRegistrations = 0;
    uint32_t successCount = 0;
    uint32_t failureCount = 0;
    std::unordered_map<std::string, uint32_t> failuresByCode;

    for (uint32_t iteration = 0; iteration < iterations; iteration++) {
        AXObserverRef observer = nullptr;
        auto createStart = Clock::now();
        AXError createErr = AXObserverCreate(pid, axObserverBenchmarkCallback, &observer);
        auto createEnd = Clock::now();
        createObserverMs += std::chrono::duration<double, std::milli>(createEnd - createStart).count();
        if (createErr != kAXErrorSuccess || !observer) {
            failureCount += 1;
            recordAxFailure(failuresByCode, createErr);
            continue;
        }
        successCount += 1;

        for (const auto& target : targets) {
            for (CFStringRef notification : target.notifications) {
                totalRegistrations += 1;

                auto addStart = Clock::now();
                AXError addErr = AXObserverAddNotification(observer, target.element, notification, nullptr);
                auto addEnd = Clock::now();
                addNotificationsMs += std::chrono::duration<double, std::milli>(addEnd - addStart).count();

                if (addErr != kAXErrorSuccess) {
                    failureCount += 1;
                    recordAxFailure(failuresByCode, addErr);
                    continue;
                }
                successCount += 1;

                auto removeStart = Clock::now();
                AXError removeErr = AXObserverRemoveNotification(observer, target.element, notification);
                auto removeEnd = Clock::now();
                removeNotificationsMs += std::chrono::duration<double, std::milli>(removeEnd - removeStart).count();

                if (removeErr != kAXErrorSuccess) {
                    failureCount += 1;
                    recordAxFailure(failuresByCode, removeErr);
                    continue;
                }
                successCount += 1;
            }
        }

        CFRelease(observer);
    }

    for (AXUIElementRef ref : ownedRefs) {
        CFRelease(ref);
    }
    CFRelease(appEl);

    auto result = Napi::Object::New(env);
    result.Set("pid", (int32_t)pid);
    result.Set("mode", mode);
    result.Set("iterations", iterations);
    result.Set("createObserverMs", createObserverMs);
    result.Set("addNotificationsMs", addNotificationsMs);
    result.Set("removeNotificationsMs", removeNotificationsMs);
    result.Set("totalRegistrations", totalRegistrations);
    result.Set("successCount", successCount);
    result.Set("failureCount", failureCount);
    result.Set("targetCount", (uint32_t)targets.size());

    auto failures = Napi::Object::New(env);
    for (const auto& [key, count] : failuresByCode) {
        failures.Set(key, count);
    }
    result.Set("failuresByCode", failures);
    return result;
}

// ─── Pasteboard ─────────────────────────────────────────────────────────────────

// pbRead(type?: string): string | null
static Napi::Value PbRead(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    std::string type = "public.utf8-plain-text";
    if (info.Length() > 0 && info[0].IsString()) {
        type = info[0].As<Napi::String>().Utf8Value();
    }
    __block std::string result;
    __block bool hasResult = false;

    auto read = ^{
        @autoreleasepool {
            NSPasteboard* pb = [NSPasteboard generalPasteboard];
            NSString* pbType = [NSString stringWithUTF8String:type.c_str()];
            NSData* data = [pb dataForType:pbType];
            if (!data) return;
            const char* bytes = (const char*)[data bytes];
            if (!bytes) return;
            result.assign(bytes, [data length]);
            hasResult = true;
        }
    };

    if ([NSThread isMainThread]) {
        read();
    } else {
        dispatch_sync(dispatch_get_main_queue(), read);
    }

    if (!hasResult) return env.Null();
    return Napi::String::New(env, result);
}

// pbWrite(text: string, type?: string): boolean
static Napi::Value PbWrite(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsString()) {
        Napi::TypeError::New(env, "pbWrite requires a string argument").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    std::string text = info[0].As<Napi::String>().Utf8Value();
    std::string type = "public.utf8-plain-text";
    if (info.Length() > 1 && info[1].IsString()) {
        type = info[1].As<Napi::String>().Utf8Value();
    }

    __block bool ok = false;
    auto write = ^{
        @autoreleasepool {
            NSPasteboard* pb = [NSPasteboard generalPasteboard];
            [pb clearContents];
            NSString* nsText = [NSString stringWithUTF8String:text.c_str()];
            NSString* nsType = [NSString stringWithUTF8String:type.c_str()];
            ok = [pb setString:nsText forType:nsType];
        }
    };

    if ([NSThread isMainThread]) {
        write();
    } else {
        dispatch_sync(dispatch_get_main_queue(), write);
    }
    return Napi::Boolean::New(env, ok);
}

// pbTypes(): string[]
static Napi::Value PbTypes(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    __block std::vector<std::string> types;

    auto getTypes = ^{
        @autoreleasepool {
            NSArray<NSPasteboardType>* pbTypes = [[NSPasteboard generalPasteboard] types];
            if (!pbTypes) return;
            types.reserve((size_t)[pbTypes count]);
            for (NSPasteboardType type in pbTypes) {
                if (!type) continue;
                types.push_back(std::string([type UTF8String]));
            }
        }
    };

    if ([NSThread isMainThread]) {
        getTypes();
    } else {
        dispatch_sync(dispatch_get_main_queue(), getTypes);
    }

    auto arr = Napi::Array::New(env);
    for (uint32_t i = 0; i < types.size(); i++) {
        arr.Set(i, types[i]);
    }
    return arr;
}

// pbClear(): boolean
static Napi::Value PbClear(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    auto clear = ^{
        @autoreleasepool {
            [[NSPasteboard generalPasteboard] clearContents];
        }
    };

    if ([NSThread isMainThread]) {
        clear();
    } else {
        dispatch_sync(dispatch_get_main_queue(), clear);
    }
    return Napi::Boolean::New(env, true);
}

// ─── Display (Multi-Monitor) ────────────────────────────────────────────────────

// wsGetDisplays(): DisplayInfo[]
static Napi::Value WsGetDisplays(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    struct DisplayInfoSnapshot {
        CGDirectDisplayID id = 0;
        std::string name;
        bool main = false;
        NSRect frame = NSZeroRect;
        NSRect visibleFrame = NSZeroRect;
        double scale = 1.0;
        CGSize physicalSize = CGSizeZero;
        double rotation = 0.0;
    };

    __block std::vector<DisplayInfoSnapshot> displays;
    auto collectDisplays = ^{
        @autoreleasepool {
            NSArray<NSScreen*>* screens = [NSScreen screens];
            if (!screens) return;

            NSScreen* mainScreen = [NSScreen mainScreen];
            displays.reserve((size_t)[screens count]);

            for (NSScreen* screen in screens) {
                NSDictionary* desc = [screen deviceDescription];
                CGDirectDisplayID displayId = [[desc objectForKey:@"NSScreenNumber"] unsignedIntValue];
                DisplayInfoSnapshot snapshot;
                snapshot.id = displayId;
                NSString* localizedName = [screen localizedName];
                snapshot.name = localizedName ? std::string([localizedName UTF8String]) : "";
                snapshot.main = (screen == mainScreen);
                snapshot.frame = [screen frame];
                snapshot.visibleFrame = [screen visibleFrame];
                snapshot.scale = (double)[screen backingScaleFactor];
                snapshot.physicalSize = CGDisplayScreenSize(displayId);
                snapshot.rotation = (double)CGDisplayRotation(displayId);
                displays.push_back(std::move(snapshot));
            }
        }
    };

    if ([NSThread isMainThread]) {
        collectDisplays();
    } else {
        dispatch_sync(dispatch_get_main_queue(), collectDisplays);
    }

    auto arr = Napi::Array::New(env);
    for (uint32_t i = 0; i < displays.size(); i++) {
        const DisplayInfoSnapshot& display = displays[i];
        auto obj = Napi::Object::New(env);
        obj.Set("id", (double)display.id);
        obj.Set("name", display.name);
        obj.Set("main", display.main);

        auto frameObj = Napi::Object::New(env);
        frameObj.Set("x", display.frame.origin.x);
        frameObj.Set("y", display.frame.origin.y);
        frameObj.Set("width", display.frame.size.width);
        frameObj.Set("height", display.frame.size.height);
        obj.Set("frame", frameObj);

        auto visFrameObj = Napi::Object::New(env);
        visFrameObj.Set("x", display.visibleFrame.origin.x);
        visFrameObj.Set("y", display.visibleFrame.origin.y);
        visFrameObj.Set("width", display.visibleFrame.size.width);
        visFrameObj.Set("height", display.visibleFrame.size.height);
        obj.Set("visibleFrame", visFrameObj);

        obj.Set("scale", display.scale);

        auto physObj = Napi::Object::New(env);
        physObj.Set("width", display.physicalSize.width);
        physObj.Set("height", display.physicalSize.height);
        obj.Set("physicalSize", physObj);

        obj.Set("rotation", display.rotation);
        arr.Set(i, obj);
    }
    return arr;
}

// ─── CG Keyboard State ──────────────────────────────────────────────────────

// Key code for modifier keys (left-hand variants)
static CGKeyCode modifierVirtualKeyCode(const std::string& mod) {
    if (mod == "cmd" || mod == "command") return 55;   // kVK_Command (left)
    if (mod == "shift") return 56;                      // kVK_Shift (left)
    if (mod == "alt" || mod == "option") return 58;     // kVK_Option (left)
    if (mod == "ctrl" || mod == "control") return 59;   // kVK_Control (left)
    return 0xFFFF;
}

// cgKeyDown({ key: string, mods?: string[] }): void
// Posts only the key-down half of a CGKeyboard event.
static Napi::Value CgKeyDown(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsObject()) {
        Napi::TypeError::New(env, "Expected options object").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    auto opts = info[0].As<Napi::Object>();
    if (!opts.Has("key") || !opts.Get("key").IsString()) {
        Napi::TypeError::New(env, "Expected 'key' string").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    std::string keyName = opts.Get("key").As<Napi::String>().Utf8Value();
    std::transform(keyName.begin(), keyName.end(), keyName.begin(), ::tolower);

    std::vector<std::string> modifiers;
    if (opts.Has("mods") && opts.Get("mods").IsArray()) {
        auto modArr = opts.Get("mods").As<Napi::Array>();
        for (uint32_t i = 0; i < modArr.Length(); i++) {
            modifiers.push_back(modArr.Get(i).As<Napi::String>().Utf8Value());
        }
    }
    CGEventFlags modFlags = parseModifierFlags(modifiers);

    CGKeyCode keyCode = virtualKeyCodeForName(keyName);
    if (keyCode == 0xFFFF) {
        Napi::Error::New(env, std::string("Unknown key name: '") + keyName + "'").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    CGEventSourceRef eventSource = CGEventSourceCreate(kCGEventSourceStateCombinedSessionState);
    CGEventRef down = CGEventCreateKeyboardEvent(eventSource, keyCode, true);
    if (!down) {
        if (eventSource) CFRelease(eventSource);
        Napi::Error::New(env, "Cannot create CGEvent — accessibility permission?").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    CGEventSetFlags(down, modFlags);
    CGEventPost(kCGSessionEventTap, down);
    CFRelease(down);
    if (eventSource) CFRelease(eventSource);
    return env.Undefined();
}

// cgKeyUp({ key: string, mods?: string[] }): void
// Posts only the key-up half of a CGKeyboard event.
static Napi::Value CgKeyUp(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsObject()) {
        Napi::TypeError::New(env, "Expected options object").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    auto opts = info[0].As<Napi::Object>();
    if (!opts.Has("key") || !opts.Get("key").IsString()) {
        Napi::TypeError::New(env, "Expected 'key' string").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    std::string keyName = opts.Get("key").As<Napi::String>().Utf8Value();
    std::transform(keyName.begin(), keyName.end(), keyName.begin(), ::tolower);

    std::vector<std::string> modifiers;
    if (opts.Has("mods") && opts.Get("mods").IsArray()) {
        auto modArr = opts.Get("mods").As<Napi::Array>();
        for (uint32_t i = 0; i < modArr.Length(); i++) {
            modifiers.push_back(modArr.Get(i).As<Napi::String>().Utf8Value());
        }
    }
    CGEventFlags modFlags = parseModifierFlags(modifiers);

    CGKeyCode keyCode = virtualKeyCodeForName(keyName);
    if (keyCode == 0xFFFF) {
        Napi::Error::New(env, std::string("Unknown key name: '") + keyName + "'").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    CGEventSourceRef eventSource = CGEventSourceCreate(kCGEventSourceStateCombinedSessionState);
    CGEventRef up = CGEventCreateKeyboardEvent(eventSource, keyCode, false);
    if (!up) {
        if (eventSource) CFRelease(eventSource);
        Napi::Error::New(env, "Cannot create CGEvent — accessibility permission?").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    CGEventSetFlags(up, modFlags);
    CGEventPost(kCGSessionEventTap, up);
    CFRelease(up);
    if (eventSource) CFRelease(eventSource);
    return env.Undefined();
}

// cgModDown(mods: string[]): void
// Posts modifier key-down events for each named modifier.
static Napi::Value CgModDown(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsArray()) {
        Napi::TypeError::New(env, "Expected array of modifier names").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    auto modArr = info[0].As<Napi::Array>();
    std::vector<std::string> mods;
    for (uint32_t i = 0; i < modArr.Length(); i++) {
        mods.push_back(modArr.Get(i).As<Napi::String>().Utf8Value());
    }
    CGEventFlags flags = parseModifierFlags(mods);
    CGEventSourceRef eventSource = CGEventSourceCreate(kCGEventSourceStateCombinedSessionState);
    for (auto& mod : mods) {
        CGKeyCode code = modifierVirtualKeyCode(mod);
        if (code == 0xFFFF) {
            if (eventSource) CFRelease(eventSource);
            Napi::Error::New(env, std::string("Unknown modifier: '") + mod + "'").ThrowAsJavaScriptException();
            return env.Undefined();
        }
        CGEventRef ev = CGEventCreateKeyboardEvent(eventSource, code, true);
        if (ev) {
            CGEventSetFlags(ev, flags);
            CGEventPost(kCGSessionEventTap, ev);
            CFRelease(ev);
        }
    }
    if (eventSource) CFRelease(eventSource);
    return env.Undefined();
}

// cgModUp(mods: string[]): void
// Posts modifier key-up events for each named modifier.
static Napi::Value CgModUp(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsArray()) {
        Napi::TypeError::New(env, "Expected array of modifier names").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    auto modArr = info[0].As<Napi::Array>();
    std::vector<std::string> mods;
    for (uint32_t i = 0; i < modArr.Length(); i++) {
        mods.push_back(modArr.Get(i).As<Napi::String>().Utf8Value());
    }
    CGEventSourceRef eventSource = CGEventSourceCreate(kCGEventSourceStateCombinedSessionState);
    for (auto& mod : mods) {
        CGKeyCode code = modifierVirtualKeyCode(mod);
        if (code == 0xFFFF) {
            if (eventSource) CFRelease(eventSource);
            Napi::Error::New(env, std::string("Unknown modifier: '") + mod + "'").ThrowAsJavaScriptException();
            return env.Undefined();
        }
        CGEventRef ev = CGEventCreateKeyboardEvent(eventSource, code, false);
        if (ev) {
            // No flags on release — modifier is being lifted
            CGEventSetFlags(ev, (CGEventFlags)0);
            CGEventPost(kCGSessionEventTap, ev);
            CFRelease(ev);
        }
    }
    if (eventSource) CFRelease(eventSource);
    return env.Undefined();
}

// ─── CG Pointer State ───────────────────────────────────────────────────────

// cgGetMousePosition(): { x: number, y: number }
// Returns the current cursor position from CG HID system state.
static Napi::Value CgGetMousePosition(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    CGEventRef event = CGEventCreate(NULL);
    CGPoint loc = CGEventGetLocation(event);
    CFRelease(event);
    auto result = Napi::Object::New(env);
    result.Set("x", (double)loc.x);
    result.Set("y", (double)loc.y);
    return result;
}

// cgGetMouseState(): { x: number, y: number, buttons: { left: bool, right: bool, middle: bool } }
// Returns cursor position and current button state.
static Napi::Value CgGetMouseState(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    CGEventRef event = CGEventCreate(NULL);
    CGPoint loc = CGEventGetLocation(event);
    CFRelease(event);

    NSUInteger pressed = [NSEvent pressedMouseButtons];

    auto result = Napi::Object::New(env);
    result.Set("x", (double)loc.x);
    result.Set("y", (double)loc.y);

    auto buttons = Napi::Object::New(env);
    buttons.Set("left",   (bool)(pressed & (1 << 0)));
    buttons.Set("right",  (bool)(pressed & (1 << 1)));
    buttons.Set("middle", (bool)(pressed & (1 << 2)));
    result.Set("buttons", buttons);
    return result;
}

// ─── Module Init ───────────────────────────────────────────────────────────────

static Napi::Object Init(Napi::Env env, Napi::Object exports) {
    exports.Set("axSnapshot", Napi::Function::New(env, AxSnapshot));
    exports.Set("axGetCursor", Napi::Function::New(env, AxGetCursor));
    exports.Set("axPerformAction", Napi::Function::New(env, AxPerformAction));
    exports.Set("axSetValue", Napi::Function::New(env, AxSetValue));
    exports.Set("axSetSelectedTextRange", Napi::Function::New(env, AxSetSelectedTextRange));
    exports.Set("axSetWindowPosition", Napi::Function::New(env, AxSetWindowPosition));
    exports.Set("axFocusWindow", Napi::Function::New(env, AxFocusWindow));
    exports.Set("axIsProcessTrusted", Napi::Function::New(env, AxIsProcessTrusted));
    exports.Set("axRequestAccessibility", Napi::Function::New(env, AxRequestAccessibility));
    exports.Set("axGetFrontmostPid", Napi::Function::New(env, AxGetFrontmostPid));
    exports.Set("wsGetRunningApps", Napi::Function::New(env, WsGetRunningApps));
    exports.Set("wsGetFrontmostApp", Napi::Function::New(env, WsGetFrontmostApp));
    exports.Set("wsGetScreenFrame", Napi::Function::New(env, WsGetScreenFrame));
    exports.Set("cgGetWindowRects", Napi::Function::New(env, CgGetWindowRects));
    exports.Set("axSwitchApp", Napi::Function::New(env, AxSwitchApp));
    exports.Set("axPostKeyboardInput", Napi::Function::New(env, AxPostKeyboardInput));
    exports.Set("axPostOverlay", Napi::Function::New(env, AxPostOverlay));
    exports.Set("axPointerEvent", Napi::Function::New(env, AxPointerEvent));
    exports.Set("axScreenshot", Napi::Function::New(env, AxScreenshot));
    exports.Set("keychainReadGenericPassword", Napi::Function::New(env, KeychainReadGenericPassword));
    exports.Set("axStartObserving", Napi::Function::New(env, AxStartObserving));
    exports.Set("axStopObserving", Napi::Function::New(env, AxStopObserving));
    exports.Set("axBenchmarkObserverNotifications", Napi::Function::New(env, AxBenchmarkObserverNotifications));
    exports.Set("pbRead", Napi::Function::New(env, PbRead));
    exports.Set("pbWrite", Napi::Function::New(env, PbWrite));
    exports.Set("pbTypes", Napi::Function::New(env, PbTypes));
    exports.Set("pbClear", Napi::Function::New(env, PbClear));
    exports.Set("wsGetDisplays", Napi::Function::New(env, WsGetDisplays));
    exports.Set("cgKeyDown", Napi::Function::New(env, CgKeyDown));
    exports.Set("cgKeyUp", Napi::Function::New(env, CgKeyUp));
    exports.Set("cgModDown", Napi::Function::New(env, CgModDown));
    exports.Set("cgModUp", Napi::Function::New(env, CgModUp));
    exports.Set("cgGetMousePosition", Napi::Function::New(env, CgGetMousePosition));
    exports.Set("cgGetMouseState", Napi::Function::New(env, CgGetMouseState));
    return exports;
}

NODE_API_MODULE(ghostui_ax, Init)
