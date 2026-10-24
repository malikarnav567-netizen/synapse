GeoLibre Desktop 3.4.0 (portable, x64)

Unzip this folder anywhere and run geolibre-desktop.exe. No installation or admin
rights are required.

Each time it starts, the app registers itself for the current user as the
handler for org.geolibre.desktop: links, so share-server sign-in can return to
it from the browser. This is the only registry change (HKCU\Software\Classes),
and it always points at wherever you last started the app. After moving this
folder, start the app once from the new location. After deleting it, remove
that key so sign-in links do not point at a missing exe.

Requirements:
  - Microsoft Edge WebView2 Runtime. Preinstalled on Windows 11 and current
    Windows 10. If the app does not start, install the Evergreen runtime from
    https://developer.microsoft.com/microsoft-edge/webview2/
  - The optional Python sidecar (Whitebox, raster, and format-conversion tools)
    needs Python available on your system, exactly as in the installed build.
    Vector tools and everything else run without it.

This portable build does not auto-update; download a newer zip to upgrade.
