{
  "targets": [
    {
      "target_name": "sinder_file_promises",
      "sources": ["file-promises.mm"],
      "defines": ["NAPI_VERSION=8"],
      "xcode_settings": {
        "CLANG_ENABLE_OBJC_ARC": "YES",
        "CLANG_CXX_LANGUAGE_STANDARD": "c++17",
        "MACOSX_DEPLOYMENT_TARGET": "12.0",
        "OTHER_LDFLAGS": ["-framework AppKit", "-framework UniformTypeIdentifiers"]
      }
    },
    {
      "target_name": "sinder_file_promises_test",
      "sources": ["file-promises.mm"],
      "defines": ["NAPI_VERSION=8", "SINDER_NATIVE_TEST=1"],
      "xcode_settings": {
        "CLANG_ENABLE_OBJC_ARC": "YES",
        "CLANG_CXX_LANGUAGE_STANDARD": "c++17",
        "MACOSX_DEPLOYMENT_TARGET": "12.0",
        "OTHER_LDFLAGS": ["-framework AppKit", "-framework UniformTypeIdentifiers"]
      }
    }
  ]
}
