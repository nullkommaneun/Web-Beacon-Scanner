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
 * (Respektiert die Anforderung, dass der F12-Debugger nicht immer verfügbar ist)
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
        // *** ERWEITERTE FILTER ***
        // Wir fügen offene Sensorformate (Ruuvi) und Standarddienste hinzu
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
            },
            // 3. NEU: RuuviTag (Open Source Sensor)
            {
                manufacturerData: [{
                    companyIdentifier: 0x0499 // Ruuvi Innovations Ltd.
                }]
            },
            // 4. NEU: Standard GATT-Dienste (Beispiele)
            { services: [0x180F] }, // Battery Service
            { services: [0x181A] }, // Environmental Sensing
            { services: [0x180D] }  // Heart Rate
        ];

        const scan = await navigator.bluetooth.requestLEScan({
            // acceptAllAdvertisements: true // Alternative, um *alles* zu sehen, aber 'filters' ist batterieschonender.
            filters: filters
        });

        bleScan = scan;
        navigator.bluetooth.addEventListener('advertisement', handleAdvertisement);

        log("Scan aktiv. Warte auf 'advertisement' Events...");
        log("Filter: \"iBeacon, Eddystone, RuuviTag, GATT-Dienste\"");
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
        if (data.byteLength >= 23 && data.getUint8(0) === 0x02 && data.getUint8(1) === 0x15) {
            beaconData = parseIBeacon(data);
        }
    } 
    // 2. Prüfen auf Google Eddystone (0xFEAA)
    else if (event.serviceData.has(0xfeaa)) {
        beaconData = parseEddystone(event.serviceData.get(0xfeaa));
    }
    // 3. Prüfen auf RuuviTag (0x0499)
    else if (event.manufacturerData.has(0x0499)) {
        beaconData = parseRuuviTag(event.manufacturerData.get(0x0499));
    }
    // 4. Prüfen auf Standard GATT-Dienste (als Fallback)
    else {
        if (event.serviceData.has(0x180F)) {
            beaconData = { type: 'GATT-Dienst', name: 'Batteriedienst (0x180F)' };
        } else if (event.serviceData.has(0x181A)) {
            beaconData = { type: 'GATT-Dienst', name: 'Umgebungssensor (0x181A)' };
        } else if (event.serviceData.has(0x180D)) {
            beaconData = { type: 'GATT-Dienst', name: 'Herzfrequenzmesser (0x180D)' };
        }
    }

    // Wenn kein verwertbares (oder für uns interessantes) Format, abbrechen
    if (!beaconData) {
        return;
    }
    
    // UI aktualisieren
    if (isNew) {
        // Verhindern, dass für jeden GATT-Dienst desselben Geräts eine neue Karte erstellt wird
        // (Geräte mit mehreren Diensten senden oft mehrere Pakete)
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
        updateBeaconCardRSSI(existing.cardElement, rssi);

        // Optional: Wenn ein Gerät (z.B. Eddystone-UID) bereits bekannt ist
        // und ein TLM-Paket (Telemetrie) sendet, könnten wir die Karte aktualisieren.
        // Fürs Erste ist die RSSI-Aktualisierung ausreichend.
    }
}

/**
 * Parst die iBeacon-Daten (Typ 0x0215).
 * @param {DataView} data - Der Payload.
 * @returns {object}
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
 * Parst alle Eddystone-Frame-Typen (URL, UID, TLM).
 * @param {DataView} data - Der Payload (Service 0xfeaa).
 * @returns {object | null}
 */
function parseEddystone(data) {
    const dv = new DataView(data.buffer, data.byteOffset);
    if (dv.byteLength === 0) return null;
    
    const frameType = dv.getUint8(0);

    switch (frameType) {
        // Eddystone-UID (Frame 0x00)
        case 0x00:
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
            if (data.byteLength < 14) return null;
            const battery = dv.getUint16(2, false); // in mV
            const tempInt = dv.getInt8(4);
            const tempFrac = dv.getUint8(5);
            const temperature = tempInt + (tempFrac / 256.0);
            const packets = dv.getUint32(6, false);
            const uptime = dv.getUint32(10, false) / 10.0; // in Sekunden
            
            return {
                type: 'Eddystone-TLM',
                battery: battery,
                temperature: temperature.toFixed(2),
                packets: packets,
                uptime: uptime.toFixed(1)
            };

        default:
            log(`Unbekannter Eddystone-Frame-Typ: 0x${frameType.toString(16)}`);
            return null;
    }
}

/**
 * Parst RuuviTag-Daten (Format 5).
 * @param {DataView} data - Der Payload (Hersteller 0x0499).
 * @returns {object | null}
 */
function parseRuuviTag(data) {
    const dv = new DataView(data.buffer, data.byteOffset);
    // Wir unterstützen nur das gängige "RAWv2" Format (Format 5)
    const format = dv.getUint8(0);

    if (format === 0x05) {
        if (data.byteLength < 24) return null; // Format 5 ist 24 Bytes lang
        
        // Bytes 1-2: Temperatur (Signed, Big Endian, 0.005 Celsius)
        const temp = dv.getInt16(1, false) * 0.005;
        
        // Bytes 3-4: Luftfeuchtigkeit (Unsigned, Big Endian, 0.0025 %RH)
        const humidity = dv.getUint16(3, false) * 0.0025;
        
        // Bytes 5-6: Luftdruck (Unsigned, Big Endian, 0.01 hPa, offset -50000 Pa)
        const pressure = (dv.getUint16(5, false) + 50000) / 100.0; // in hPa
        
        // Bytes 7-8 (Batt Volt) + 9-10 (Pwr Info)
        const batteryInfo = dv.getUint16(7, false);
        // Bits 0-10: Spannung (1mV)
        const battery = (batteryInfo >> 5) + 1600; // in mV (Offset 1600mV)
        
        return {
            type: 'RuuviTag Sensor',
            temperature: temp.toFixed(2),
            humidity: humidity.toFixed(2),
            pressure: pressure.toFixed(2),
            battery: battery
        };
    }
    
    log(`Unbekanntes RuuviTag-Format: 0x${format.toString(16)}`);
    return null;
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
            
        // NEU: RuuviTag
        case 'RuuviTag Sensor':
            title = "RuuviTag Sensor (RAWv2)";
            borderColor = "border-cyan-500";
            content = `
                <p class="text-sm text-gray-700">Temperatur: <strong class="font-mono">${beaconData.temperature} °C</strong></p>
                <p class="text-sm text-gray-700">Luftfeuchtigkeit: <strong class="font-mono">${beaconData.humidity} %RH</strong></p>
                <p class="text-sm text-gray-700">Luftdruck: <strong class="font-mono">${beaconData.pressure} hPa</strong></p>
                <p class="text-sm text-gray-700">Batterie: <strong class="font-mono">${beaconData.battery} mV</strong></p>
            `;
            break;

        // NEU: GATT-Dienste
        case 'GATT-Dienst':
            title = "GATT-Dienst erkannt";
            borderColor = "border-gray-400";
            content = `
                <p class="text-sm text-gray-700">Gerät bewirbt: <strong class="font-mono">${beaconData.name}</strong></p>
                <p class="text-xs text-gray-500 italic mt-1">Dies ist eine Ankündigung. Zum Auslesen der Daten ist eine Verbindung (GATT) erforderlich.</p>
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
 *Gibt den Hex-String OHNE "0x" Präfix zurück.
 * @returns {string}
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


 
