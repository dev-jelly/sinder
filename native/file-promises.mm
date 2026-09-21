#import <AppKit/AppKit.h>
#import <UniformTypeIdentifiers/UniformTypeIdentifiers.h>
#include <node_api.h>
#include <string>
#include <stdio.h>
#include <errno.h>

#ifdef SINDER_NATIVE_TEST
#define SinderPromiseOwner SinderTestPromiseOwner
#define SinderPromiseProvider SinderTestPromiseProvider
#endif

// A real NSFilePromiseProvider lets Finder accept a remote file immediately.
// Downloading only starts when a receiver actually requests the promised file.
// No placeholder file is exposed while an SSH download is incomplete.
@class SinderPromiseOwner;
struct Delivery {
  __strong SinderPromiseOwner *owner;
  __strong NSURL *destination;
  __strong void (^completion)(NSError *);
  size_t index;
  bool finished = false;
};

static NSError *Failure(NSString *message) {
  return [NSError errorWithDomain:@"app.sinder.file-promise" code:1
                        userInfo:@{NSLocalizedDescriptionKey: message}];
}
static std::string String(napi_env env, napi_value value) {
  size_t length = 0;
  if (napi_get_value_string_utf8(env, value, nullptr, 0, &length) != napi_ok)
    return "";
  std::string result(length + 1, '\0');
  napi_get_value_string_utf8(env, value, result.data(), result.size(), &length);
  result.resize(length);
  return result;
}
static napi_value Undefined(napi_env env) {
  napi_value value;
  napi_get_undefined(env, &value);
  return value;
}

struct CompletionResult {
  napi_deferred deferred;
  __strong NSError *error;
};
static void FinishCopy(napi_env env, napi_value callback, void *context, void *data) {
  auto result = static_cast<CompletionResult *>(data);
  if (env) {
    if (result->error) {
      napi_value message, error;
      napi_create_string_utf8(env, result->error.localizedDescription.UTF8String, NAPI_AUTO_LENGTH, &message);
      napi_create_error(env, nullptr, message, &error);
      napi_reject_deferred(env, result->deferred, error);
    } else {
      napi_resolve_deferred(env, result->deferred, Undefined(env));
    }
  }
  delete result;
}

@interface SinderPromiseOwner : NSObject <NSFilePromiseProviderDelegate, NSDraggingSource>
@property(nonatomic) napi_threadsafe_function callback;
@property(nonatomic, strong) NSOperationQueue *queue;
@end

@interface SinderPromiseProvider : NSFilePromiseProvider
// NSFilePromiseProvider's delegate is weak. Keep it alive for as long as the
// receiver retains the provider, including writes after the drag has ended.
@property(nonatomic, strong) SinderPromiseOwner *owner;
@property(nonatomic, copy) NSString *filename;
@property(nonatomic, copy) NSString *internalPayload;
@property(nonatomic) size_t index;
@end

@implementation SinderPromiseProvider
- (NSArray<NSPasteboardType> *)writableTypesForPasteboard:(NSPasteboard *)pasteboard {
  NSArray *types = [super writableTypesForPasteboard:pasteboard];
  return self.internalPayload.length ? [types arrayByAddingObject:NSPasteboardTypeString] : types;
}
- (id)pasteboardPropertyListForType:(NSPasteboardType)type {
  if ([type isEqualToString:NSPasteboardTypeString]) return self.internalPayload;
  return [super pasteboardPropertyListForType:type];
}
@end

static void Abandon(napi_env env, void *data, void *hint) {
  auto delivery = static_cast<Delivery *>(data);
  if (!delivery->finished)
    delivery->completion(Failure(@"Sinder could not finish the download."));
  delete delivery;
}

static napi_value Complete(napi_env env, napi_callback_info info) {
  napi_value args[2];
  size_t count = 2;
  void *data;
  napi_get_cb_info(env, info, &count, args, nullptr, &data);
  auto delivery = static_cast<Delivery *>(data);
  if (delivery->finished) return Undefined(env);
  delivery->finished = true;
  const auto message = count ? String(env, args[0]) : "";
  const auto source = count > 1 ? String(env, args[1]) : "";
  auto completion = delivery->completion;
  NSURL *destination = delivery->destination;
  if (!message.empty() || source.empty()) {
    completion(Failure(message.empty() ? @"No downloaded file was returned."
                                       : [NSString stringWithUTF8String:message.c_str()]));
    return Undefined(env);
  }
  NSURL *sourceURL = [NSURL fileURLWithPath:[NSString stringWithUTF8String:source.c_str()]];
  napi_value promise, resource;
  napi_deferred deferred;
  napi_create_promise(env, &deferred, &promise);
  napi_create_string_utf8(env, "Sinder file delivery", NAPI_AUTO_LENGTH, &resource);
  napi_threadsafe_function finished;
  napi_create_threadsafe_function(env, nullptr, nullptr, resource, 0, 1,
      nullptr, nullptr, nullptr, FinishCopy, &finished);
  napi_unref_threadsafe_function(env, finished);
  // Coordinate with Finder without blocking Electron's main thread. Copy into
  // our own temporary directory, then publish a complete file without replacing
  // an existing destination. Cleanup only ever touches this owned directory.
  [delivery->owner.queue addOperationWithBlock:^{
    NSFileCoordinator *coordinator = [[NSFileCoordinator alloc] initWithFilePresenter:nil];
    __block NSError *writeError = nil;
    NSError *coordinationError = nil;
    [coordinator coordinateWritingItemAtURL:destination options:0 error:&coordinationError
        byAccessor:^(NSURL *target) {
      NSFileManager *manager = NSFileManager.defaultManager;
      std::string pattern = [[[target URLByDeletingLastPathComponent]
          URLByAppendingPathComponent:@".sinder-promise-XXXXXX"].path fileSystemRepresentation];
      char *created = mkdtemp(pattern.data());
      if (!created) {
        writeError = Failure(@"Cannot create a temporary folder in the destination.");
        return;
      }
      NSURL *temporary = [NSURL fileURLWithFileSystemRepresentation:created isDirectory:YES relativeToURL:nil];
      NSURL *staged = [temporary URLByAppendingPathComponent:@"item"];
      if ([manager copyItemAtURL:sourceURL toURL:staged error:&writeError] &&
          renamex_np(staged.fileSystemRepresentation, target.fileSystemRepresentation, RENAME_EXCL) != 0)
        writeError = [NSError errorWithDomain:NSPOSIXErrorDomain code:errno userInfo:nil];
      [manager removeItemAtURL:temporary error:nil];
    }];
    completion(writeError ?: coordinationError);
    auto result = new CompletionResult{deferred, writeError ?: coordinationError};
    if (napi_call_threadsafe_function(finished, result, napi_tsfn_nonblocking) != napi_ok) delete result;
    napi_release_threadsafe_function(finished, napi_tsfn_release);
  }];
  return promise;
}

static void Request(napi_env env, napi_value callback, void *context, void *data) {
  auto delivery = static_cast<Delivery *>(data);
  if (!env || !callback) {
    delivery->completion(Failure(@"Sinder was closed before the download completed."));
    delete delivery;
    return;
  }
  napi_value index, complete;
  napi_create_uint32(env, static_cast<uint32_t>(delivery->index), &index);
  napi_create_function(env, "completeFilePromise", NAPI_AUTO_LENGTH, Complete, delivery, &complete);
  napi_add_finalizer(env, complete, delivery, Abandon, nullptr, nullptr);
  napi_value args[] = {index, complete};
  napi_value result;
  if (napi_call_function(env, Undefined(env), callback, 2, args, &result) != napi_ok) {
    delivery->finished = true;
    delivery->completion(Failure(@"Could not start the download."));
    bool pending = false;
    napi_is_exception_pending(env, &pending);
    if (pending) napi_get_and_clear_last_exception(env, &result);
  }
}

@implementation SinderPromiseOwner
- (void)dealloc {
  if (_callback) napi_release_threadsafe_function(_callback, napi_tsfn_release);
}
- (NSString *)filePromiseProvider:(NSFilePromiseProvider *)provider fileNameForType:(NSString *)type {
  return ((SinderPromiseProvider *)provider).filename;
}
- (NSOperationQueue *)operationQueueForFilePromiseProvider:(NSFilePromiseProvider *)provider {
  return self.queue;
}
- (void)filePromiseProvider:(NSFilePromiseProvider *)provider writePromiseToURL:(NSURL *)url
         completionHandler:(void (^)(NSError *))completion {
  auto delivery = new Delivery{self, url, completion, ((SinderPromiseProvider *)provider).index};
  if (napi_call_threadsafe_function(self.callback, delivery, napi_tsfn_nonblocking) != napi_ok) {
    completion(Failure(@"Sinder is no longer available."));
    delete delivery;
  }
}
- (NSDragOperation)draggingSession:(NSDraggingSession *)session sourceOperationMaskForDraggingContext:(NSDraggingContext)context {
  // Finder receives copies. Sinder reads the text payload for internal moves.
  return context == NSDraggingContextWithinApplication ? NSDragOperationCopy | NSDragOperationMove : NSDragOperationCopy;
}
@end

static NSArray<SinderPromiseProvider *> *Providers(napi_env env, napi_value entries,
    napi_value payloadValue, napi_value callback) {
  uint32_t count = 0;
  napi_get_array_length(env, entries, &count);
  if (count == 0 || count > 1000) return nil;
  SinderPromiseOwner *owner = [SinderPromiseOwner new];
  owner.queue = [NSOperationQueue new];
  owner.queue.maxConcurrentOperationCount = 2;
  napi_value resource;
  napi_create_string_utf8(env, "Sinder file promises", NAPI_AUTO_LENGTH, &resource);
  napi_threadsafe_function tsfn;
  if (napi_create_threadsafe_function(env, callback, nullptr, resource, 0, 1,
      nullptr, nullptr, nullptr, Request, &tsfn) != napi_ok) return nil;
  owner.callback = tsfn;
  napi_unref_threadsafe_function(env, tsfn);
  const auto payload = String(env, payloadValue);
  NSMutableArray<SinderPromiseProvider *> *providers = [NSMutableArray new];
  for (uint32_t i = 0; i < count; i++) {
    napi_value entry, nameValue, directoryValue;
    napi_get_element(env, entries, i, &entry);
    napi_get_named_property(env, entry, "name", &nameValue);
    napi_get_named_property(env, entry, "directory", &directoryValue);
    const auto name = String(env, nameValue);
    bool directory = false;
    napi_get_value_bool(env, directoryValue, &directory);
    NSString *filename = [NSString stringWithUTF8String:name.c_str()];
    if (!filename.length || ![filename.lastPathComponent isEqualToString:filename] ||
        [filename isEqualToString:@"."] || [filename isEqualToString:@".."]) return nil;
    UTType *type = directory ? UTTypeFolder : [UTType typeWithFilenameExtension:filename.pathExtension];
    SinderPromiseProvider *provider = [[SinderPromiseProvider alloc]
        initWithFileType:(type ?: UTTypeData).identifier delegate:owner];
    provider.owner = owner;
    provider.filename = filename;
    if (i == 0) provider.internalPayload = [NSString stringWithUTF8String:payload.c_str()];
    provider.index = i;
    [providers addObject:provider];
  }
  return providers;
}

static napi_value StartDrag(napi_env env, napi_callback_info info) {
  napi_value args[4];
  size_t count = 4;
  napi_get_cb_info(env, info, &count, args, nullptr, nullptr);
  void *buffer = nullptr;
  size_t length = 0;
  if (count != 4 || napi_get_buffer_info(env, args[0], &buffer, &length) != napi_ok ||
      length != sizeof(void *)) {
    napi_throw_error(env, nullptr, "A native window handle is required.");
    return nullptr;
  }
  NSView *view = (__bridge NSView *)*static_cast<void **>(buffer);
  NSArray *providers = Providers(env, args[1], args[2], args[3]);
  if (!view.window || !providers) {
    napi_throw_error(env, nullptr, "Cannot create the file drag.");
    return nullptr;
  }
  NSPoint location = view.window.mouseLocationOutsideOfEventStream;
  NSEvent *event = [NSEvent mouseEventWithType:NSEventTypeLeftMouseDragged location:location
      modifierFlags:NSEvent.modifierFlags timestamp:NSProcessInfo.processInfo.systemUptime
      windowNumber:view.window.windowNumber context:nil eventNumber:0 clickCount:1 pressure:1];
  NSPoint origin = [view convertPoint:location fromView:nil];
  NSMutableArray *items = [NSMutableArray new];
  for (SinderPromiseProvider *provider in providers) {
    NSDraggingItem *item = [[NSDraggingItem alloc] initWithPasteboardWriter:provider];
    NSImage *image = [NSWorkspace.sharedWorkspace iconForContentType:[UTType typeWithIdentifier:provider.fileType] ?: UTTypeData];
    [item setDraggingFrame:NSMakeRect(origin.x, origin.y, 32, 32) contents:image];
    [items addObject:item];
  }
  @try {
    [view beginDraggingSessionWithItems:items event:event source:((SinderPromiseProvider *)providers[0]).owner];
  } @catch (NSException *exception) {
    napi_throw_error(env, nullptr, exception.reason.UTF8String);
    return nullptr;
  }
  return Undefined(env);
}

#ifdef SINDER_NATIVE_TEST
static NSMutableArray *testResults = [NSMutableArray new];
static NSMutableArray *testObjects = [NSMutableArray new];
// Compile only into the separate test addon, never included in the app bundle.
// Verify that AppKit recognizes the promised types, then invoke the delegate
// request a real drop receiver makes. OS pointer transfer is a separate manual
// check; a pasteboard alone does not establish a system drag session.
static napi_value ReceiveForTest(napi_env env, napi_callback_info info) {
  napi_value args[4];
  size_t count = 4;
  napi_get_cb_info(env, info, &count, args, nullptr, nullptr);
  NSArray *providers = Providers(env, args[0], args[1], args[2]);
  @synchronized(testResults) { [testResults removeAllObjects]; }
  const auto target = String(env, args[3]);
  NSPasteboard *pasteboard = [NSPasteboard pasteboardWithUniqueName];
  [pasteboard writeObjects:providers];
  NSArray<NSFilePromiseReceiver *> *receivers = [pasteboard readObjectsForClasses:@[NSFilePromiseReceiver.class] options:@{}];
  NSOperationQueue *queue = [NSOperationQueue new];
  [testObjects addObjectsFromArray:@[providers, pasteboard, receivers, queue]];
  NSURL *destination = [NSURL fileURLWithPath:[NSString stringWithUTF8String:target.c_str()] isDirectory:YES];
  for (SinderPromiseProvider *provider in providers) {
    NSURL *url = [destination URLByAppendingPathComponent:provider.filename];
    [queue addOperationWithBlock:^{
      [provider.owner filePromiseProvider:provider writePromiseToURL:url completionHandler:^(NSError *error) {
        @synchronized(testResults) {
          [testResults addObject:@{@"path": url.path ?: @"", @"error": error.localizedDescription ?: @""}];
        }
      }];
    }];
  }
  napi_value result;
  napi_create_uint32(env, static_cast<uint32_t>(receivers.count), &result);
  return result;
}
static napi_value ResultsForTest(napi_env env, napi_callback_info info) {
  NSData *json;
  @synchronized(testResults) { json = [NSJSONSerialization dataWithJSONObject:testResults options:0 error:nil]; }
  napi_value result;
  napi_create_string_utf8(env, static_cast<const char *>(json.bytes), json.length, &result);
  return result;
}
#endif

static napi_value Init(napi_env env, napi_value exports) {
  napi_value start;
  napi_create_function(env, "startDrag", NAPI_AUTO_LENGTH, StartDrag, nullptr, &start);
  napi_set_named_property(env, exports, "startDrag", start);
#ifdef SINDER_NATIVE_TEST
  napi_value receive;
  napi_create_function(env, "receiveForTest", NAPI_AUTO_LENGTH, ReceiveForTest, nullptr, &receive);
  napi_set_named_property(env, exports, "receiveForTest", receive);
  napi_create_function(env, "results", NAPI_AUTO_LENGTH, ResultsForTest, nullptr, &receive);
  napi_set_named_property(env, exports, "results", receive);
#endif
  return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
