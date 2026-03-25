{
  "targets": [
    {
      "target_name": "ghostui_ax",
      "sources": ["ax.mm"],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")"
      ],
      "defines": ["NAPI_DISABLE_CPP_EXCEPTIONS"],
      "xcode_settings": {
        "CLANG_CXX_LANGUAGE_STANDARD": "c++17",
        "MACOSX_DEPLOYMENT_TARGET": "13.0",
        "OTHER_LDFLAGS": [
          "-framework", "ApplicationServices",
          "-framework", "CoreGraphics",
          "-framework", "AppKit",
          "-framework", "Carbon",
          "-framework", "Security"
        ]
      }
    }
  ]
}
