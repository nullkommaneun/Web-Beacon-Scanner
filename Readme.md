Web-Beacon-Scanner
Dies ist ein einfacher "Öffentlicher Beacon Scanner", der direkt im Chrome-Browser über die Web Bluetooth API nach iBeacons und Eddystone-URLs sucht und die decodierten Informationen anzeigt.
Projektziel
Das Ziel ist eine leichtgewichtige Webanwendung, die ohne Installation auf HTTPS-fähigen Plattformen (wie GitHub Pages) läuft. Sie nutzt die navigator.bluetooth.requestLEScan() API, um Bluetooth Low Energy (BLE) Advertisements zu filtern und zu parsen.
Funktionen
 * Dual-Scan: Scannt gleichzeitig nach iBeacons und Eddystone-Beacons.
 * iBeacon-Decoder: Extrahiert UUID, Major und Minor.
 * Eddystone-URL-Decoder: Extrahiert und decodiert physische Web-URLs (Frame Type 0x10).
 * Echtzeit-UI: Zeigt gefundene Beacons als "Karten" an.
 * RSSI-Aktualisierung: Aktualisiert den RSSI-Wert bekannter Beacons in Echtzeit, anstatt Duplikate zu erstellen.
 * On-Screen-Debug: Ein integriertes Textfenster zeigt Statusmeldungen und Fehler an, nützlich für Tests auf Mobilgeräten ohne F12-Debugger.
Nutzung
 * Hosten Sie diese Dateien (index.html, style.css, script.js) auf einem Webserver, der HTTPS verwendet (z.B. GitHub Pages).
 * Rufen Sie die Seite mit einem kompatiblen Browser auf (siehe unten).
 * Klicken Sie auf "Scan Starten".
 * Erteilen Sie dem Browser die Erlaubnis, Bluetooth zu verwenden und wählen Sie ggf. ein Gerät aus (oft nicht nötig, der Scan läuft im Hintergrund).
Technologie-Stack
 * HTML5
 * Tailwind CSS (via CDN für schnelles Prototyping und sauberes UI)
 * Vanilla JavaScript (ES6+)
 * Web Bluetooth API (requestLEScan)
Wichtiger Hinweis zur Kompatibilität
Die Web Bluetooth API (requestLEScan) ist ein experimentelles Feature und wird nicht von allen Browsern unterstützt.
 * Erforderlich: Die Seite muss über HTTPS bereitgestellt werden.
 * Desktop: Chrome (Windows, macOS, Linux).
 * Mobil: Chrome für Android.
 * Nicht unterstützt: Firefox, Safari (iOS/macOS) unterstützen diese spezifische Scan-API derzeit nicht.
