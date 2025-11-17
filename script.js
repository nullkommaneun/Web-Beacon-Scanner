// Das Skript wird durch 'defer' in index.html erst ausgeführt, wenn das DOM geladen ist.
// Der 'DOMContentLoaded' Event-Listener wird daher nicht mehr benötigt.

// DOM-Elemente abrufen
const scanStartBtn = document.getElementById('scan-start-btn');
const scanStopBtn = document.getElementById('scan-stop-btn');
const debugLog = document.getElementById('debug-log');
const resultsDiv = document.getElementById('results');

// Globaler Status
let bleScan = null; // Das aktive Scan-Objekt
let discoveredDevices = new Map(); // Speichert gefundene Geräte (Key: device.id)

/**
 * Schreibt eine Nachricht in das On-Screen-Debug-Fenster und die Konsole.
 * @param {string} message - Die zu loggende Nachricht.
 */
function log(message) {
    console.log(message);
    // (Wir behalten das Debug-Fenster bei, wie gewünscht)
    const timestamp = new Date().toLocaleTimeString('de-DE');
    debugLog.value = `[${timestamp}] ${message}\n` + debugLog.value;
    // Log auf 100 Zeilen begrenzen, um Überlauf zu vermeiden
    const lines = debugLog.value.split('\n');
    if (lines.length > 100) {
        debugLog.value = lines.slice(0, 100).join('\n');
    }
}

/**
 * Startet den Bluetooth LE Scan.
 */
async function startScan() {
    log("Scan wird angefordert...");
    
    // Prüfen, ob Web Bluetooth verfügbar ist
    if (!navigator.bluetooth) {
        log("FEHLER: Web Bluetooth API wird von diesem Browser nicht unterstützt.");
        // (Verwende keine 'alert', da dies blockierend ist und in iFrames oft fehlschlägt)
        log("HINWEIS: Web Bluetooth benötigt HTTPS und einen kompatiblen Browser (z.B. Chrome).");
        return;
    }

    // UI-Status aktualisieren
    scanStartBtn.disabled = true;
    
    try {
        // Filter wie vom Benutzer gewünscht:
        // 1. iBeacon: Apple (0x004C) mit Präfix 0x0215
        // 2. Eddystone: Service UUID 0xfeaa
        const filters = [
            { 
                manufacturerData: [{ 
                    companyIdentifier: 0x004C, 
                    dataPrefix: new Uint8Array([0x02, 0x15]) 
                }] 
            },
            { 
                services: [0xfeaa] 
            }
        ];

        // Scan anfordern (requestLEScan)
        const scan = await navigator.bluetooth.requestLEScan({
            filters: filters
        });

        bleScan = scan; // Scan-Objekt global speichern

        // Event Listener für gefundene Advertisements hinzufügen
        navigator.bluetooth.addEventListener('advertisement', handleAdvertisement);

        log("Scan aktiv. Warte auf 'advertisement' Events...");
        log("Filter: \"iBeacon & Eddystone\""); // Vereinfachte Log-Ausgabe
        scanStopBtn.disabled = false;

    } catch (error) {
        log(`FEHLER beim Starten des Scans: ${error.message}`);
        if (error.name === 'NotFoundError') {
            log("Info: Der Benutzer hat das Bluetooth-Geräteauswahl-Fenster geschlossen.");
        }
        scanStartBtn.disabled = false; // Button wieder fregeben
    }
}

/**
 * Stoppt den aktiven Bluetooth LE Scan.
 */
function stopScan() {
    log("Scan wird gestoppt...");
    
    // Event Listener entfernen
    navigator.bluetooth.removeEventListener('advertisement', handleAdvertisement);
    
    if (bleScan) {
        try {
            bleScan.stop();
            bleScan = null;
            log("Scan erfolgreich gestoppt.");
        } catch (error) {
            log(`FEHLER beim Stoppen des Scans: ${error.message}`);
        }
    }

    // UI-Status zurücksetzen
    scanStartBtn.disabled = false;
    scanStopBtn.disabled = true;
}

/**
 * Verarbeitet eingehende Advertisement-Pakete.
 * @param {Event} event - Das Advertisement-Event.
 */
function handleAdvertisement(event) {
    const deviceId = event.device.id;
    const rssi = event.rssi;
    const isNew = !discoveredDevices.has(deviceId);

    let beaconData = null;

    // 1. Prüfen, ob es ein iBeacon ist (wurde bereits gefiltert)
    if (event.manufacturerData.has(0x004C)) {
        const data = event.manufacturerData.get(0x004C);
        // Doppelte Prüfung (obwohl Filter aktiv ist)
        if (data.byteLength >= 23 && data.getUint8(0) === 0x02 && data.getUint8(1) === 0x15) {
            beaconData = parseIBeacon(data);
        }
    }
    
    // 2. Prüfen, ob es ein Eddystone ist (wurde bereits gefiltert)
    else if (event.serviceData.has(0xfeaa)) {
        const data = event.serviceData.get(0xfeaa);
        beaconData = parseEddystone(data);
    }

    // Wenn kein verwertbares Format, abbrechen
    if (!beaconData) {
        return;
    }

    // UI aktualisieren
    if (isNew) {
        log(`Neuer Beacon [${beaconData.type}] gefunden: ${deviceId.substring(0, 10)}...`);
        // Neue Karte erstellen und zum DOM hinzufügen
        const cardElement = createBeaconCard(beaconData, rssi, deviceId);
        resultsDiv.prepend(cardElement); // Oben anfügen
        // Gerät in der Map speichern
        discoveredDevices.set(deviceId, { 
            device: event.device, 
            cardElement: cardElement, 
            type: beaconData.type 
        });
    } else {
        // RSSI-Wert auf vorhandener Karte aktualisieren
        const existing = discoveredDevices.get(deviceId);
        updateBeaconCardRSSI(existing.cardElement, rssi);
    }
}

/**
 * Parst die iBeacon-Daten aus dem Manufacturer Data Payload.
 * @param {DataView} data - Der Payload (beginnend mit 0x0215).
 * @returns {object | null} - Das iBeacon-Datenobjekt oder null.
 */
function parseIBeacon(data) {
    // iBeacon-Struktur:
    // 0-1: 0x0215 (Präfix)
    // 2-17: 16 Bytes UUID
    // 18-19: 2 Bytes Major
    // 20-21: 2 Bytes Minor
    // 22: 1 Byte TX Power (wird hier ignoriert)
    
    // DataView für einfaches Lesen von Multi-Byte-Werten
    const dv = new DataView(data.buffer, data.byteOffset);

    // UUID extrahieren (Bytes 2-17)
    const uuidBytes = new Uint8Array(dv.buffer, dv.byteOffset + 2, 16);
    const uuid = bytesToUuid(uuidBytes);

    // Major extrahieren (Bytes 18-19)
    const major = dv.getUint16(18, false); // Big Endian

    // Minor extrahieren (Bytes 20-21)
    const minor = dv.getUint16(20, false); // Big Endian

    return { type: 'iBeacon', uuid, major, minor };
}

/**
 * Parst die Eddystone-Daten aus dem Service Data Payload.
 * @param {DataView} data - Der Payload (Service UUID 0xfeaa).
 * @returns {object | null} - Das Eddystone-Datenobjekt oder null.
 */
function parseEddystone(data) {
    // Eddystone-Struktur (Service Data):
    // 0: Frame Type
    // ...
    
    const dv = new DataView(data.buffer, data.byteOffset);
    const frameType = dv.getUint8(0);

    // Nur Eddystone-URL (Typ 0x10) wird unterstützt
    if (frameType === 0x10) {
        const url = decodeEddystoneUrl(dv);
        return { type: 'Eddystone-URL', url };
    }
    
    // Andere Typen (UID, TLM) werden ignoriert
    return null;
}

/**
 * Decodiert eine Eddystone-URL (Frame Type 0x10).
 * @param {DataView} dataView - Der Eddystone-Payload (beginnend mit 0x10).
 * @returns {string} - Die decodierte URL.
 */
function decodeEddystoneUrl(dataView) {
    // Struktur Eddystone-URL (0x10):
    // 0: 0x10 (Frame Type)
    // 1: TX Power (wird ignoriert)
    // 2: URL Scheme Prefix (0x00-0x03)
    // 3+: Encoded URL
    
    let url = "";
    
    // URL Scheme Präfix (Byte 2)
    const schemeCode = dataView.getUint8(2);
    const schemes = ["http://www.", "https://www.", "http://", "https://"];
    if (schemeCode < schemes.length) {
        url += schemes[schemeCode];
    }

    // URL decodieren (Bytes 3 bis Ende)
    const expansions = [
        ".com/", ".org/", ".edu/", ".net/", ".info/", ".biz/", ".gov/",
        ".com", ".org", ".edu", ".net", ".info", ".biz", ".gov"
    ];

    for (let i = 3; i < dataView.byteLength; i++) {
        const code = dataView.getUint8(i);
        
        // Prüfen, ob es ein Expansion-Code ist (0x00 - 0x0D)
        if (code < expansions.length) {
            url += expansions[code];
        } else {
            // Andernfalls ist es ein normales ASCII-Zeichen
            url += String.fromCharCode(code);
        }
    }
    
    return url;
}

/**
 * Erstellt eine HTML-Karte für einen gefundenen Beacon.
 * @param {object} beaconData - Das geparste Beacon-Objekt.
 * @param {number} rssi - Der aktuelle RSSI-Wert.
 * @param {string} deviceId - Die ID des Geräts.
 * @returns {HTMLElement} - Das DIV-Element der Karte.
 */
function createBeaconCard(beaconData, rssi, deviceId) {
    const card = document.createElement('div');
    card.setAttribute('data-device-id', deviceId);
    
    let title, content, borderColor;

    if (beaconData.type === 'iBeacon') {
        title = "iBeacon";
        borderColor = "border-blue-500";
        content = `
            <p class="text-xs text-gray-500 break-all">UUID: <strong class="font-mono">${beaconData.uuid}</strong></p>
            <p class="text-sm text-gray-700">Major: <strong class="font-mono">${beaconData.major}</strong></p>
            <p class="text-sm text-gray-700">Minor: <strong class="font-mono">${beaconData.minor}</strong></p>
        `;
    } else if (beaconData.type === 'Eddystone-URL') {
        title = "Eddystone-URL";
        borderColor = "border-green-500";
        content = `
            <p class="text-sm text-gray-700 break-all">URL: 
                <a href="${beaconData.url}" target="_blank" rel="noopener noreferrer" class="text-blue-600 hover:underline font-mono">${beaconData.url}</a>
            </p>
        `;
    }

    card.className = `bg-white p-4 rounded-lg shadow-md border-l-4 ${borderColor}`;
    card.innerHTML = `
        <div class="flex justify-between items-start mb-2">
            <h3 class="text-lg font-semibold text-gray-800">${title}</h3>
            <span class="rssi-value-wrapper text-sm font-medium text-gray-600">
                RSSI: <span class="rssi-value font-bold">${rssi}</span> dBm
            </span>
        </div>
        ${content}
        <p class="text-xs text-gray-400 mt-3 font-mono">ID: ${deviceId.substring(0, 10)}...</p>
    `;
    
    return card;
}

/**
 * Aktualisiert den RSSI-Wert auf einer bestehenden Beacon-Karte.
 * @param {HTMLElement} cardElement - Das DIV-Element der Karte.
 * @param {number} rssi - Der neue RSSI-Wert.
 */
function updateBeaconCardRSSI(cardElement, rssi) {
    const rssiSpan = cardElement.querySelector('.rssi-value');
    if (rssiSpan) {
        rssiSpan.textContent = rssi;
        // Optional: Visuelles Feedback bei Aktualisierung (kurzes Aufleuchten)
        const wrapper = cardElement.querySelector('.rssi-value-wrapper');
        if (wrapper) {
            wrapper.classList.add('text-blue-500');
            setTimeout(() => {
                wrapper.classList.remove('text-blue-500');
            }, 300);
        }
    }
}

/**
 * Konvertiert ein 16-Byte-Array in einen Standard-UUID-String.
 * @param {Uint8Array} bytes - Das 16-Byte-Array.
 * @returns {string} - Der formatierte UUID-String.
 */
function bytesToUuid(bytes) {
    const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`.toUpperCase();
}

// Event-Listener für die Buttons registrieren
scanStartBtn.addEventListener('click', startScan);
scanStopBtn.addEventListener('click', stopScan);

// Beim Laden der Seite prüfen, ob Bluetooth unterstützt wird
// Dieser Code wird jetzt direkt ausgeführt, da 'defer' das DOM garantiert.
if (navigator.bluetooth) {
    log("Web Bluetooth API ist verfügbar.");
} else {
    log("FEHLER: Web Bluetooth API wird nicht unterstützt.");
    log("INFO: Stellen Sie sicher, dass die Seite über HTTPS geladen wird.");
    scanStartBtn.disabled = true;
    scanStartBtn.textContent = "Nicht unterstützt";
}


 
