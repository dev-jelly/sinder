#import <AppKit/AppKit.h>
#import <objc/runtime.h>
#include "window-ordering.h"

#ifdef SINDER_NATIVE_TEST
#define SinderDragRegions SinderTestDragRegions
#endif

@interface SinderDragRegions : NSObject
@property(nonatomic, copy) NSArray<NSValue *> *rects;
@end
@implementation SinderDragRegions
@end

static char regionsKey, originalClassKey;

static BOOL IsFileMouseDown(NSView *view, NSEvent *event) {
  if (event.type != NSEventTypeLeftMouseDown ||
      (event.modifierFlags & NSEventModifierFlagControl)) return NO;
  NSView *root = view.window.contentView;
  SinderDragRegions *regions = objc_getAssociatedObject(root, &regionsKey);
  NSPoint point = [root convertPoint:event.locationInWindow fromView:nil];
  if (!root.isFlipped) point.y = NSHeight(root.bounds) - point.y;
  point.x -= root.bounds.origin.x;
  for (NSValue *value in regions.rects)
    if (NSPointInRect(point, value.rectValue)) return YES;
  return NO;
}

static BOOL OriginalPolicy(id view, SEL selector, NSEvent *event) {
  Class original = objc_getAssociatedObject(view, &originalClassKey);
  auto method = (BOOL (*)(id, SEL, NSEvent *))class_getMethodImplementation(original, selector);
  return method(view, selector, event);
}
static BOOL FileMousePolicy(id view, SEL selector, NSEvent *event) {
  if (IsFileMouseDown(view, event)) {
    if (getenv("SINDER_DRAG_DIAGNOSTICS") && selector == @selector(shouldDelayWindowOrderingForEvent:))
      fprintf(stderr, "[Sinder drag] delaying source window activation\n");
    return YES;
  }
  return OriginalPolicy(view, selector, event);
}

// Give only this window's view instances AppKit's standard background-drag
// policy. Never replace a method on Chromium's shared class or on NSView.
// The dynamic subclass adds no ivars and inherits all event handling unchanged.
static void InstallPolicy(NSView *view) {
  if (objc_getAssociatedObject(view, &originalClassKey)) return;
  Class original = object_getClass(view);
  NSString *name = [NSString stringWithFormat:@"%@_%s", NSStringFromClass(SinderDragRegions.class), class_getName(original)];
  Class subclass = NSClassFromString(name);
  if (!subclass) {
    subclass = objc_allocateClassPair(original, name.UTF8String, 0);
    for (NSString *methodName in @[@"shouldDelayWindowOrderingForEvent:", @"acceptsFirstMouse:"]) {
      SEL selector = NSSelectorFromString(methodName);
      Method method = class_getInstanceMethod(original, selector);
      class_addMethod(subclass, selector, (IMP)FileMousePolicy, method_getTypeEncoding(method));
    }
    objc_registerClassPair(subclass);
  }
  objc_setAssociatedObject(view, &originalClassKey, original, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
  object_setClass(view, subclass);
}

static NSView *ContentView(napi_env env, napi_value value) {
  void *buffer = nullptr;
  size_t length = 0;
  if (napi_get_buffer_info(env, value, &buffer, &length) != napi_ok || length != sizeof(void *)) {
    napi_throw_error(env, nullptr, "A native window handle is required.");
    return nil;
  }
  return (__bridge NSView *)*static_cast<void **>(buffer);
}
static napi_value SetDragRegions(napi_env env, napi_callback_info info) {
  napi_value args[2], result;
  napi_get_undefined(env, &result);
  size_t count = 2;
  napi_get_cb_info(env, info, &count, args, nullptr, nullptr);
  if (count != 2) return result;
  NSView *root = ContentView(env, args[0]);
  if (!root.window) return result;
  uint32_t length = 0;
  napi_get_array_length(env, args[1], &length);
  if (length > 10000) return result;
  NSMutableArray *rects = [NSMutableArray new];
  for (uint32_t i = 0; i < length; i++) {
    napi_value entry;
    napi_get_element(env, args[1], i, &entry);
    double values[4] = {};
    for (uint32_t j = 0; j < 4; j++) {
      napi_value value;
      napi_get_element(env, entry, j, &value);
      napi_get_value_double(env, value, &values[j]);
    }
    NSRect rect = NSMakeRect(values[0], values[1], values[2], values[3]);
    [rects addObject:[NSValue valueWithRect:rect]];
    NSPoint center = NSMakePoint(NSMidX(rect) + root.bounds.origin.x,
        root.isFlipped ? NSMidY(rect) : NSHeight(root.bounds) - NSMidY(rect));
    NSView *hit = [root hitTest:[root convertPoint:center toView:root.superview]];
    for (NSView *view = hit; view; view = view.superview) {
      InstallPolicy(view);
      if (view == root) break;
    }
  }
  SinderDragRegions *regions = [SinderDragRegions new];
  regions.rects = rects;
  objc_setAssociatedObject(root, &regionsKey, regions, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
  return result;
}

static napi_value PreventWindowOrdering(napi_env env, napi_callback_info info) {
  [NSApp preventWindowOrdering];
  napi_value result;
  napi_get_undefined(env, &result);
  return result;
}

#ifdef SINDER_NATIVE_TEST
// Probe the actual hit-tested AppKit view, including the production addon's
// overrides, without synthesizing input or activating a user's windows.
static napi_value InspectPolicy(napi_env env, napi_callback_info info) {
  napi_value args[4], result;
  size_t count = 4;
  napi_get_cb_info(env, info, &count, args, nullptr, nullptr);
  NSView *root = ContentView(env, args[0]);
  double x = 0, y = 0;
  bool control = false;
  napi_get_value_double(env, args[1], &x);
  napi_get_value_double(env, args[2], &y);
  if (count > 3) napi_get_value_bool(env, args[3], &control);
  NSPoint point = NSMakePoint(x, root.isFlipped ? y : NSHeight(root.bounds) - y);
  NSView *hit = [root hitTest:[root convertPoint:point toView:root.superview]];
  NSEvent *event = [NSEvent mouseEventWithType:NSEventTypeLeftMouseDown
      location:[root convertPoint:point toView:nil]
      modifierFlags:control ? NSEventModifierFlagControl : 0
      timestamp:NSProcessInfo.processInfo.systemUptime windowNumber:root.window.windowNumber
      context:nil eventNumber:0 clickCount:1 pressure:1];
  napi_create_object(env, &result);
  napi_value value;
  napi_get_boolean(env, [hit shouldDelayWindowOrderingForEvent:event], &value);
  napi_set_named_property(env, result, "delaysOrdering", value);
  napi_get_boolean(env, [hit acceptsFirstMouse:event], &value);
  napi_set_named_property(env, result, "acceptsFirstMouse", value);
  return result;
}
#endif

void RegisterWindowOrdering(napi_env env, napi_value exports) {
  napi_value method;
  napi_create_function(env, "setDragRegions", NAPI_AUTO_LENGTH, SetDragRegions, nullptr, &method);
  napi_set_named_property(env, exports, "setDragRegions", method);
  napi_create_function(env, "preventWindowOrdering", NAPI_AUTO_LENGTH, PreventWindowOrdering, nullptr, &method);
  napi_set_named_property(env, exports, "preventWindowOrdering", method);
#ifdef SINDER_NATIVE_TEST
  napi_create_function(env, "inspectWindowOrdering", NAPI_AUTO_LENGTH, InspectPolicy, nullptr, &method);
  napi_set_named_property(env, exports, "inspectWindowOrdering", method);
#endif
}
