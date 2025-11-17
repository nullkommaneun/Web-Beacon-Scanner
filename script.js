// Das Skript wird durch 'defer' in index.html erst ausgeführt, wenn das DOM geladen ist.

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
    const timestamp = new Date().toLocaleTimeString('de-DE');
    debugLog.value = `[${timestamp}] ${message}\n` + debugLog.value;
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
    
    if (!navigator.bluetooth) {
        log("FEHLER: Web Bluetooth API wird von diesem Browser nicht unterstützt.");
        log("HINWEIS: Web Bluetooth benötigt HTTPS und einen kompatiblen Browser (z.B. Chrome).");
        return;
    }

    scanStartBtn.disabled = true;
    
    try {
        // *** Angepasste Filter ***
        // Wir filtern nur nach Formaten, die gelesen werden WOLLEN.
        const filters = [
            // 1. iBeacon (Apple)
            { 
                manufacturerData: [{ 
                    companyIdentifier: 0x004C, 
                    dataPrefix: new Uint8Array([0x02, 0x15]) 
                }] 
            },
            // 2. Eddystone (Alle Typen: URL, UID, TLM)
            { 
                services: [0xfeaa] 
            }
        ];

        const scan = await navigator.bluetooth.requestLEScan({
            filters: filters
        });

        bleScan = scan;
        navigator.bluetooth.addEventListener('advertisement', handleAdvertisement);

        log("Scan aktiv. Warte auf 'advertisement' Events...");
        log("Filter: \"iBeacon & Eddystone (Alle Typen)\"");
        scanStopBtn.disabled = false;

    } catch (error) {
        log(`FEHLER beim Starten des Scans: ${error.message}`);
        if (error.name === 'NotFoundError') {
            log("Info: Der Benutzer hat das Bluetooth-Geräteauswahl-Fenster geschlossen.");
        }
        scanStartBtn.disabled = false;
    }
}

/**
 * Stoppt den aktiven Bluetooth LE Scan.
 */
function stopScan() {
    log("Scan wird gestoppt...");
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

    // 1. Prüfen auf Apple iBeacon (0x004C)
    if (event.manufacturerData.has(0x004C)) {
        const data = event.manufacturerData.get(0x004C);
        // A. Ist es iBeacon (0x0215)?
        if (data.byteLength >= 23 && data.getUint8(0) === 0x02 && data.getUint8(1) === 0x15) {
            beaconData = parseIBeacon(data);
        }
        // (Andere Apple-Formate wie "Find My" werden ignoriert)
    } 
    // 2. Prüfen auf Google Eddystone (0xFEAA) - Alle Frame-Typen
    else if (event.serviceData.has(0xfeaa)) {
        const data = event.serviceData.get(0xfeaa);
        beaconData = parseEddystone(data); // Diese Funktion parst jetzt URL, UID und TLM
    }

    // Wenn kein verwertbares (oder für uns interessantes) Format, abbrechen
    if (!beaconData) {
        // TLM-Pakete werden oft ohne Geräte-ID (und ohne 'isNew' Flag) gesendet.
        // Wir müssen prüfen, ob ein TLM für ein *bekanntes* Gerät gesendet wird.
        if (event.serviceData.has(0xfeaa)) {
            const tlmData = parseEddystone(event.serviceData.get(0xfeaa));
            if (tlmData && tlmData.type === 'Eddystone-TLM') {
                // Versuche, die TLM-Daten einer vorhandenen Karte zuzuordnen
                // (Dies ist komplex, da TLM oft die ID nicht mitsendet)
                // Fürs Erste loggen wir es, wenn wir es nicht zuordnen können.
                if (!discoveredDevices.has(deviceId)) {
                     log(`TLM-Paket empfangen, kann aber keinem Gerät zugeordnet werden (ID: ${deviceId.substring(0,10)}...).`);
                }
            }
        }
        return;
    }
    
    // UI aktualisieren
    if (isNew) {
        // Ein Eddystone-Beacon sendet möglicherweise abwechselnd UID- und TLM-Pakete.
        // Wir wollen nur *eine* Karte pro Gerät.
        log(`Neuer Beacon [${beaconData.type}] gefunden: ${deviceId.substring(0, 10)}...`);
        const cardElement = createBeaconCard(beaconData, rssi, deviceId);
        resultsDiv.prepend(cardElement);
        discoveredDevices.set(deviceId, { 
            device: event.device, 
            cardElement: cardElement, 
            type: beaconData.type 
        });
    } else {
        const existing = discoveredDevices.get(deviceId);
        // RSSI-Wert auf vorhandener Karte aktualisieren
        updateBeaconCardRSSI(existing.cardElement, rssi);

        // Wenn ein neues Paket für ein bekanntes Gerät hereinkommt,
        // (z.B. TLM-Daten für einen bekannten UID-Beacon),
        // könnten wir die Karte aktualisieren.
        // Vorerst aktualisieren wir nur RSSI, um Duplikate zu vermeiden.
    }
}

/**
 * Parst die iBeacon-Daten aus dem Manufacturer Data Payload.
 * @param {DataView} data - Der Payload (beginnend mit 0x0215).
 * @returns {object | null} - Das iBeacon-Datenobjekt oder null.
 */
function parseIBeacon(data) {
    const dv = new DataView(data.buffer, data.byteOffset);
    const uuidBytes = new Uint8Array(dv.buffer, dv.byteOffset + 2, 16);
    const uuid = bytesToUuid(uuidBytes);
    const major = dv.getUint16(18, false); // Big Endian
    const minor = dv.getUint16(20, false); // Big Endian
    return { type: 'iBeacon', uuid, major, minor };
}

/**
 * Parst die Eddystone-Daten aus dem Service Data Payload.
 * Unters
 * @param {DataView} data - Der Payload (Service UUID 0xfeaa).
 * @returns {object | null} - Das Eddystone-Datenobjekt oder null.
 */
function parseEddystone(data) {
    const dv = new DataView(data.buffer, data.byteOffset);
    const frameType = dv.getUint8(0);

    switch (frameType) {
        // Eddystone-UID (Frame 0x00)
        case 0x00:
            // 0: 0x00 (Frame Type)
            // 1: TX Power (ignoriert)
            // 2-11: 10-byte Namespace
            // 12-17: 6-byte Instance
            if (data.byteLength < 18) return null;
            const namespaceBytes = new Uint8Array(dv.buffer, dv.byteOffset + 2, 10);
            const instanceBytes = new Uint8Array(dv.buffer, dv.byteOffset + 12, 6);
            return {
                type: 'Eddystone-UID',
                namespace: bytesToHex(namespaceBytes),
                instance: bytesToHex(instanceBytes)
            };

        // Eddystone-URL (Frame 0x10)
        case 0x10:
            if (data.byteLength < 4) return null;
            const url = decodeEddystoneUrl(dv);
            return { type: 'Eddystone-URL', url };

        // Eddystone-TLM (Telemetry, Frame 0x20)
        case 0x20:
            // 0: 0x20 (Frame Type)
            // 1: Version (ignoriert)
            // 2-3: Battery voltage (mV, Big Endian)
            // 4-5: Temperature (Signed 8.8 fixed-point, Big Endian)
            // 6-9: Advertising PDU count (Big Endian)
            // 10-13: Time since power-on (0.1s, Big Endian)
            if (data.byteLength < 14) return null;
            const battery = dv.getUint16(2, false); // in mV
            
            // Temperatur ist 8.8 fixed-point
            const tempInt = dv.getInt8(4);
            const tempFrac = dv.getUint8(5);
            const temperature = tempInt + (tempFrac / 256.0);
            
            const packets = dv.getUint32(6, false);
            const uptime = dv.getUint32(10, false) / 10.0; // in Sekunden
            
            return {
                type: 'Eddystone-TLM',
                battery: battery,
                temperature: temperature.toFixed(2), // 2 Nachkommastellen
                packets: packets,
                uptime: uptime.toFixed(1) // 1 Nachkommastelle
            };

        default:
            return null; // Andere Eddystone-Typen (EID, etc.) ignorieren wir
    }
}

/**
 * Decodiert eine Eddystone-URL (Frame Type 0x10).
 * @param {DataView} dataView - Der Eddystone-Payload (beginnend mit 0x10).
 * @returns {string} - Die decodierte URL.
 */
function decodeEddystoneUrl(dataView) {
    let url = "";
    const schemeCode = dataView.getUint8(2);
    const schemes = ["http://www.", "https://www.", "http://", "https://"];
    if (schemeCode < schemes.length) {
        url += schemes[schemeCode];
    }

    const expansions = [
        ".com/", ".org/", ".edu/", ".net/", ".info/", ".biz/", ".gov/",
        ".com", ".org", ".edu", ".net/", ".info/", ".biz/", ".gov/"
    ];

    for (let i = 3; i < dataView.byteLength; i++) {
        const code = dataView.getUint8(i);
        if (code < expansions.length) {
            url += expansions[code];
        } else {
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

    switch (beaconData.type) {
        case 'iBeacon':
            title = "iBeacon";
            borderColor = "border-blue-500";
            content = `
                <p class="text-xs text-gray-500 break-all">UUID: <strong class="font-mono">${beaconData.uuid}</strong></p>
                <p class="text-sm text-gray-700">Major: <strong class="font-mono">${beaconData.major}</strong></p>
                <p class="text-sm text-gray-700">Minor: <strong class="font-mono">${beaconData.minor}</strong></p>
            `;
            break;

        case 'Eddystone-URL':
            title = "Eddystone-URL";
            borderColor = "border-green-500";
            content = `
                <p class="text-sm text-gray-700 break-all">URL: 
                    <a href="${beaconData.url}" target="_blank" rel="noopener noreferrer" class="text-blue-600 hover:underline font-mono">${beaconData.url}</a>
                </p>
            `;
            break;

        // NEUE KARTEN-TYPEN:
        case 'Eddystone-UID':
            title = "Eddystone-UID";
            borderColor = "border-purple-500";
            content = `
                <p class="text-xs text-gray-500 break-all">Namespace: <strong class="font-mono">${beaconData.namespace}</strong></p>
                <p class="text-xs text-gray-500 break-all">Instance: <strong class="font-mono">${beaconData.instance}</strong></p>
            `;
            break;

        case 'Eddystone-TLM':
            title = "Eddystone-TLM (Telemetrie)";
            borderColor = "border-orange-500";
            content = `
                <p class="text-sm text-gray-700">Batterie: <strong class="font-mono">${beaconData.battery} mV</strong></p>
                <p class="text-sm text-gray-700">Temperatur: <strong class="font-mono">${beaconData.temperature} °C</strong></p>
                <p class="text-sm text-gray-700">Pakete: <strong class="font-mono">${beaconData.packets}</strong></p>
                <p class="text-sm text-gray-700">Laufzeit: <strong class="font-mono">${beaconData.uptime} s</strong></p>
            `;
            break;

        default:
            title = "Unbekannt";
            borderColor = "border-red-500";
            content = `<p class="text-sm text-gray-700">Unbekannter Paket-Typ erkannt.</p>`;
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
        const wrapper = cardElement.querySelector('.rssi-value-wrapper');
        if (wrapper) {
            wrapper.classList.add('text-blue-500'); // Kurzes Aufleuchten
            setTimeout(() => {
                wrapper.classList.remove('text-blue-500');
            }, 300);
        }
    }
}

/**
 * Hilfsfunktion: Konvertiert ein 16-Byte-Array in einen Standard-UUID-String.
 * @param {Uint8Array} bytes - Das 16-Byte-Array.
 * @returns {string} - Der formatierte UUID-String.
 */
function bytesToUuid(bytes) {
    const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`.toUpperCase();
}

/**
 * Hilfsfunktion: Konvertiert eine DataView (oder Uint8Array) in einen Hex-String.
 * @param {DataView | Uint8Array} data 
 * @returns {string} - Der Hex-String (OHNE "0x").
 */
function bytesToHex(data) {
    let bytes;
    if (data instanceof DataView) {
        bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    } else if (data instanceof Uint8Array) {
        bytes = data;
    } else {
        return "N/A";
    }
    
    return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('').toUpperCase();
}


// --- Initialisierung ---

// Event-Listener für die Buttons registrieren
scanStartBtn.addEventListener('click', startScan);
scanStopBtn.addEventListener('click', stopScan);

// Beim Laden der Seite prüfen, ob Bluetooth unterstützt wird
if (navigator.bluetooth) {
    log("Web Bluetooth API ist verfügbar.");
} else {
    log("FEHLER: Web Bluetooth API wird nicht unterstützt.");
    log("INFO: Stellen Sie sicher, dass die Seite über HTTPS geladen wird.");
    scanStartBtn.disabled = true;
    scanStartBtn.textContent = "Nicht unterstützt";
}


 
