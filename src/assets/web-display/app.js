/**
 * OpenLap Web Display - Real-time Race Interface
 * Displays live race data from OpenLap mobile app
 */

class RaceDisplay {
    constructor() {
        this.isConnected = false;
        this.lastUpdate = null;
        // WebSocket only - no more API JSON polling
        this.websocket = null;
        this.wsPort = 8081; // Fixed port - matches server
        this.reconnectDelay = 1000; // Start with 1s
        this.maxReconnectDelay = 3000; // Max 3s
        this.updateThrottle = null;
        this.throttleDelay = 100; // 100ms throttle
        
        this.currentData = {
            race: {
                mode: 'practice',
                status: 'stopped',
                time: 0,
                laps: 0,
                currentLap: 0
            },
            leaderboard: [],
            realtime: {
                timestamp: 0,
                cars: []
            }
        };

        this.elements = {
            raceMode: document.getElementById('raceMode'),
            raceStatus: document.getElementById('raceStatus'),
            raceTime: document.getElementById('raceTime'),
            currentLap: document.getElementById('currentLap'),
            totalLaps: document.getElementById('totalLaps'),
            leaderboard: document.getElementById('leaderboard'),
            timingGrid: document.getElementById('timingGrid'),
            connectionStatus: document.getElementById('connectionStatus'),
            connectionText: document.getElementById('connectionText'),
            lastUpdate: document.getElementById('lastUpdate'),
            serverInfo: document.getElementById('serverInfo'),
            totalLapsCompleted: document.getElementById('totalLapsCompleted'),
            fastestLap: document.getElementById('fastestLap'),
            raceDuration: document.getElementById('raceDuration'),
            activeCars: document.getElementById('activeCars')
        };

        this.init();
    }

    init() {
        console.log('OpenLap Race Display initialized');
        this.updateConnectionStatus(false, 'Connexion...');
        this.connectWebSocket();
        this.setupEventListeners();
        this.showWelcomeMessage();
    }

    setupEventListeners() {
        // Handle page visibility changes
        document.addEventListener('visibilitychange', () => {
            if (document.hidden) {
                this.disconnectWebSocket();
            } else {
                this.connectWebSocket();
            }
        });

        // Handle window focus/blur
        window.addEventListener('focus', () => this.connectWebSocket());
        window.addEventListener('blur', () => this.disconnectWebSocket());

        // Theme switching (can be controlled via URL parameter)
        const urlParams = new URLSearchParams(window.location.search);
        const theme = urlParams.get('theme');
        if (theme) {
            this.setTheme(theme);
        }
    }

    setTheme(themeName) {
        const body = document.body;
        body.className = body.className.replace(/theme-\w+/, '');
        body.classList.add(`theme-${themeName}`);
    }

    // API JSON polling methods removed - WebSocket only now

    handleDataUpdate(data) {
        this.currentData = data;
        this.lastUpdate = new Date();
        
        // Throttle updates to avoid excessive DOM manipulation
        if (this.updateThrottle) {
            clearTimeout(this.updateThrottle);
        }
        
        this.updateThrottle = setTimeout(() => {
            this.updateRaceHeader(data.race);
            this.updateLeaderboard(data.leaderboard);
            this.updateRealtime(data.realtime);
            this.updateStats(data);
            this.updateLastUpdateTime();
        }, this.throttleDelay);
    }

    updateRaceHeader(raceData) {
        // Traduction des modes
        const modeTranslations = {
            'practice': 'ENTRAÎNEMENT',
            'qualifying': 'QUALIFICATIONS',
            'race': 'COURSE'
        };
        this.elements.raceMode.textContent = modeTranslations[raceData.mode.toLowerCase()] || raceData.mode.toUpperCase();

        // Traduction des statuts
        const statusTranslations = {
            'stopped': 'ARRÊTÉ',
            'ready': 'PRÊT',
            'running': 'EN COURS',
            'finished': 'TERMINÉE',
            'paused': 'PAUSE',
            'waiting': 'EN ATTENTE'
        };
        this.elements.raceStatus.textContent = statusTranslations[raceData.status.toLowerCase()] || raceData.status.toUpperCase();

        // Ajouter des classes CSS spécifiques selon le statut
        let statusClass = 'race-status';
        if (raceData.status.toLowerCase().includes('cours') || raceData.status.toLowerCase() === 'running') {
            statusClass += ' running';
        } else if (raceData.status.toLowerCase().includes('attente') || raceData.status.toLowerCase() === 'waiting') {
            statusClass += ' waiting';
        } else if (raceData.status.toLowerCase().includes('prêt') || raceData.status.toLowerCase() === 'ready') {
            statusClass += ' ready';
        } else if (raceData.status.toLowerCase().includes('terminée') || raceData.status.toLowerCase() === 'finished') {
            statusClass += ' finished';
        }
        this.elements.raceStatus.className = statusClass;

        this.elements.raceTime.textContent = this.formatDuration(raceData.time);
        this.elements.currentLap.textContent = `Tour ${raceData.currentLap}`;
        this.elements.totalLaps.textContent = raceData.laps === 0 ? '∞' : raceData.laps;

        // Mettre à jour les feux de départ
        this.updateStartLights(raceData.startLights || 0, raceData.startBlink || false);
    }

    updateStartLights(lights, blink) {
        // Récupérer tous les feux
        const lightElements = document.querySelectorAll('.start-light');

        lightElements.forEach((light, index) => {
            const lightNumber = index + 1;

            // Retirer toutes les classes
            light.classList.remove('active', 'blink', 'green');

            if (blink) {
                // Faux départ : tous les feux clignotent en rouge
                light.classList.add('active', 'blink');
            } else if (lights === 0) {
                // Course lancée : tous les feux passent au vert
                light.classList.add('green');
            } else if (lightNumber <= lights) {
                // Séquence de départ : feux rouges progressifs
                light.classList.add('active');
            }
        });
    }

    updateLeaderboard(leaderboardData) {
        console.log('🔄 updateLeaderboard called with', leaderboardData.length, 'entries');
        const container = this.elements.leaderboard;
        const existingEntries = Array.from(container.children);
        
        console.log('📊 Found', existingEntries.length, 'existing entries in DOM');
        
        // Create a map of existing entries by car number
        const existingMap = new Map();
        existingEntries.forEach(entry => {
            const carNum = entry.querySelector('.car-number')?.textContent;
            console.log('🔍 Found existing car number:', carNum);
            if (carNum) existingMap.set(parseInt(carNum), entry);
        });

        console.log('🗺️ Existing map size:', existingMap.size);

        // Track which entries we need to keep
        const toKeep = new Set();
        
        leaderboardData.forEach((entry, index) => {
            const existingEntry = existingMap.get(entry.car);
            toKeep.add(entry.car);
            
            console.log(`🎯 Processing car ${entry.car}: ${existingEntry ? 'UPDATE' : 'CREATE'} - ${entry.driver}`);
            
            if (existingEntry) {
                // Update existing entry smoothly
                this.updateLeaderboardEntry(existingEntry, entry, index);
            } else {
                // Create new entry
                const entryElement = this.createLeaderboardEntry(entry);
                entryElement.classList.add('entry-new');
                container.appendChild(entryElement);
                
                // Trigger animation after DOM insertion
                setTimeout(() => {
                    entryElement.classList.remove('entry-new');
                    entryElement.classList.add('entry-visible');
                }, 10);
            }
        });

        // Remove entries that are no longer needed
        existingEntries.forEach(entry => {
            const carNum = entry.querySelector('.car-number')?.textContent;
            if (carNum && !toKeep.has(parseInt(carNum))) {
                entry.style.opacity = '0';
                entry.style.transform = 'translateX(-100%)';
                setTimeout(() => {
                    if (entry.parentNode) entry.parentNode.removeChild(entry);
                }, 300);
            }
        });

        // Reorder entries if needed
        this.reorderLeaderboard(container, leaderboardData);
    }

    createLeaderboardEntry(entry) {
        const entryElement = document.createElement('div');
        entryElement.className = `leaderboard-entry position-${entry.position}`;
        entryElement.dataset.carNumber = entry.car;
        
        entryElement.innerHTML = `
            <div class="position">${entry.position}</div>
            <div class="car-number" style="background-color: ${entry.color}">${entry.car}</div>
            <div class="driver-name">${entry.driver || `Car ${entry.car}`}</div>
            <div class="lap-count">${entry.laps}</div>
            <div class="time">${this.formatTime(entry.time || 0)}</div>
            <div class="last-lap">${entry.lastLap || '--:--:---'}</div>
            <div class="best-lap">${entry.bestLap || '--:--:---'}</div>
            <div class="gap">${entry.gap || '--'}</div>
            <div class="pits">${entry.pits || 0}</div>
            <div class="fuel-gauge">
                <div class="fuel-fill" style="width: ${Math.max(0, Math.min(100, (entry.fuel || 0) * 100 / 15))}%"></div>
                <span class="fuel-text">${entry.fuel || 0}</span>
            </div>
            <div class="throttle-status">
                <div class="throttle-bar">
                    <div class="throttle-fill" style="height: ${Math.max(0, Math.min(100, entry.throttle || 0))}%"></div>
                </div>
                <div class="button-indicator ${entry.buttonPressed ? 'pressed' : 'released'}">
                    ${entry.buttonPressed ? '●' : '○'}
                </div>
            </div>
            <div class="payment-status">${this.getPaymentStatus(entry)}</div>
            <div class="pit-status">${this.getPitStatus(entry)}</div>
            <div class="car-status">${this.getCarStatus(entry)}</div>
            <div class="brake-wear ${this.getBrakeWearClass(entry.brakeWear !== undefined ? entry.brakeWear : 15)}">
                <span class="brake-icon">🔴</span>
                <span class="brake-value">${entry.brakeWear !== undefined ? entry.brakeWear : 15}</span>
            </div>
        `;

        return entryElement;
    }

    getPitStatus(entry) {
        if (!entry.pit) return '';
        return entry.refuel ? 'REFUEL' : 'PIT';
    }

    getCarStatus(entry) {
        if (entry.finished) return '🏁';
        if (entry.pit) return entry.refuel ? '⛽' : '🔧';
        return '';
    }

    getPaymentStatus(entry) {
        // Logique identique à l'affichage natif
        if (entry.manuallyBlocked) return '🔴'; // Rouge - bloqué manuellement
        if (entry.manuallyUnblocked && !entry.manuallyBlocked) return '🟢'; // Vert - débloqué manuellement
        if (!entry.manuallyBlocked && !entry.manuallyUnblocked && entry.hasPaid) return '🪙'; // Pièce - a payé
        if (!entry.manuallyBlocked && !entry.manuallyUnblocked && !entry.hasPaid) return '⚫'; // Noir - pas payé
        return '⚫';
    }

    getBrakeWearClass(brakeWear) {
        // 15-12: green (new/good), 11-6: yellow (worn), 5-0: red (critical)
        if (brakeWear >= 12) return 'brake-good';
        if (brakeWear >= 6) return 'brake-worn';
        return 'brake-critical';
    }

    updateLeaderboardEntry(element, entry, index) {
        const position = element.querySelector('.position');
        const carNumber = element.querySelector('.car-number');
        const driverName = element.querySelector('.driver-name');
        const lapCount = element.querySelector('.lap-count');
        const lastLap = element.querySelector('.last-lap');
        const bestLap = element.querySelector('.best-lap');
        const gap = element.querySelector('.gap');
        const time = element.querySelector('.time');
        const pits = element.querySelector('.pits');
        const fuelFill = element.querySelector('.fuel-fill');
        const fuelText = element.querySelector('.fuel-text');
        const throttleFill = element.querySelector('.throttle-fill');
        const buttonIndicator = element.querySelector('.button-indicator');
        const paymentStatus = element.querySelector('.payment-status');
        const pitStatus = element.querySelector('.pit-status');
        const carStatus = element.querySelector('.car-status');

        let hasChanges = false;

        // Check for changes and update smoothly
        if (position.textContent !== entry.position.toString()) {
            position.textContent = entry.position;
            hasChanges = true;
        }

        if (carNumber.style.backgroundColor !== entry.color) {
            carNumber.style.backgroundColor = entry.color;
        }

        if (driverName.textContent !== (entry.driver || `Car ${entry.car}`)) {
            driverName.textContent = entry.driver || `Car ${entry.car}`;
        }

        if (lapCount.textContent !== entry.laps.toString()) {
            lapCount.textContent = entry.laps;
            hasChanges = true;
        }

        if (lastLap.textContent !== (entry.lastLap || '--:--:---')) {
            lastLap.textContent = entry.lastLap || '--:--:---';
            hasChanges = true;
        }

        if (bestLap.textContent !== (entry.bestLap || '--:--:---')) {
            bestLap.textContent = entry.bestLap || '--:--:---';
            hasChanges = true;
        }

        if (gap.textContent !== (entry.gap || '--')) {
            gap.textContent = entry.gap || '--';
        }

        // Update time
        const formattedTime = this.formatTime(entry.time || 0);
        if (time.textContent !== formattedTime) {
            time.textContent = formattedTime;
            hasChanges = true;
        }

        // Update pits
        if (pits.textContent !== (entry.pits || 0).toString()) {
            pits.textContent = entry.pits || 0;
            hasChanges = true;
        }

        // Update fuel gauge
        const fuelPercentage = Math.max(0, Math.min(100, (entry.fuel || 0) * 100 / 15));
        if (fuelFill.style.width !== `${fuelPercentage}%`) {
            fuelFill.style.width = `${fuelPercentage}%`;
            fuelText.textContent = entry.fuel || 0;
            hasChanges = true;
        }

        // Update throttle (but don't mark as significant change)
        const throttlePercentage = Math.max(0, Math.min(100, entry.throttle || 0));
        if (throttleFill.style.height !== `${throttlePercentage}%`) {
            throttleFill.style.height = `${throttlePercentage}%`;
            // Don't set hasChanges = true for throttle updates
        }

        // Update button status (but don't mark as significant change)
        const buttonClass = entry.buttonPressed ? 'pressed' : 'released';
        const buttonSymbol = entry.buttonPressed ? '●' : '○';
        if (!buttonIndicator.classList.contains(buttonClass)) {
            buttonIndicator.className = `button-indicator ${buttonClass}`;
            buttonIndicator.textContent = buttonSymbol;
            // Don't set hasChanges = true for button updates
        }

        // Update payment status
        const newPaymentStatus = this.getPaymentStatus(entry);
        if (paymentStatus.textContent !== newPaymentStatus) {
            paymentStatus.textContent = newPaymentStatus;
            hasChanges = true;
        }

        // Update pit status
        const newPitStatus = this.getPitStatus(entry);
        if (pitStatus.textContent !== newPitStatus) {
            pitStatus.textContent = newPitStatus;
            hasChanges = true;
        }

        // Update car status
        const newCarStatus = this.getCarStatus(entry);
        if (carStatus.textContent !== newCarStatus) {
            carStatus.textContent = newCarStatus;
            hasChanges = true;
        }

        // Update brake wear
        const brakeWear = element.querySelector('.brake-wear');
        const brakeValue = element.querySelector('.brake-value');
        if (brakeWear && brakeValue) {
            const brakeWearValue = entry.brakeWear !== undefined ? entry.brakeWear : 15;
            const newBrakeClass = this.getBrakeWearClass(brakeWearValue);

            if (brakeValue.textContent !== brakeWearValue.toString()) {
                brakeValue.textContent = brakeWearValue;
                brakeWear.className = `brake-wear ${newBrakeClass}`;
                hasChanges = true;
            } else if (!brakeWear.classList.contains(newBrakeClass)) {
                brakeWear.className = `brake-wear ${newBrakeClass}`;
            }
        }

        // Update class for position styling
        element.className = `leaderboard-entry position-${entry.position}`;
        element.dataset.carNumber = entry.car;

        // Highlight changes briefly
        if (hasChanges) {
            element.classList.add('entry-changed');
            setTimeout(() => {
                element.classList.remove('entry-changed');
            }, 1000);
        }
    }

    reorderLeaderboard(container, leaderboardData) {
        const currentOrder = Array.from(container.children);
        const targetOrder = leaderboardData.map(entry => 
            currentOrder.find(el => parseInt(el.dataset.carNumber) === entry.car)
        ).filter(Boolean);

        // Check if reordering is needed by comparing positions
        let needsReorder = false;
        if (currentOrder.length !== targetOrder.length) {
            needsReorder = true;
        } else {
            for (let i = 0; i < targetOrder.length; i++) {
                if (currentOrder[i] !== targetOrder[i]) {
                    needsReorder = true;
                    break;
                }
            }
        }

        if (needsReorder) {
            console.log('🔄 Reordering leaderboard positions');
            // Use DocumentFragment to avoid multiple DOM manipulations
            const fragment = document.createDocumentFragment();
            targetOrder.forEach(entry => {
                fragment.appendChild(entry);
            });
            container.appendChild(fragment);
        }
    }

    updateRealtime(realtimeData) {
        const container = this.elements.timingGrid;
        
        if (!realtimeData.cars || realtimeData.cars.length === 0) {
            container.innerHTML = '';
            return;
        }

        const existingEntries = Array.from(container.children);
        const existingMap = new Map();
        
        existingEntries.forEach(entry => {
            const carNum = entry.querySelector('.timing-car-number')?.textContent;
            if (carNum) existingMap.set(parseInt(carNum), entry);
        });

        const toKeep = new Set();

        realtimeData.cars.forEach(car => {
            const existingEntry = existingMap.get(car.id);
            toKeep.add(car.id);
            
            if (existingEntry) {
                this.updateTimingEntry(existingEntry, car);
            } else {
                const entryElement = this.createTimingEntry(car);
                entryElement.style.opacity = '0';
                container.appendChild(entryElement);
                
                setTimeout(() => {
                    entryElement.style.opacity = '1';
                }, 10);
            }
        });

        // Remove unused entries
        existingEntries.forEach(entry => {
            const carNum = entry.querySelector('.timing-car-number')?.textContent;
            if (carNum && !toKeep.has(parseInt(carNum))) {
                entry.style.opacity = '0';
                setTimeout(() => {
                    if (entry.parentNode) entry.parentNode.removeChild(entry);
                }, 300);
            }
        });
    }

    createTimingEntry(car) {
        const entryElement = document.createElement('div');
        entryElement.className = 'timing-entry';
        entryElement.dataset.carId = car.id;
        
        // Find car color from leaderboard
        const leaderboardEntry = this.currentData.leaderboard.find(entry => entry.car === car.id);
        const carColor = leaderboardEntry ? leaderboardEntry.color : '#666666';
        
        entryElement.innerHTML = `
            <div class="timing-car">
                <div class="timing-car-number" style="background-color: ${carColor}">${car.id}</div>
                <div class="timing-info">
                    <div class="timing-position">P${car.position}</div>
                    <div class="timing-sector">${car.sector || 'S1'}</div>
                </div>
            </div>
            <div class="timing-speed">${car.speed}%</div>
        `;

        return entryElement;
    }

    updateTimingEntry(element, car) {
        const position = element.querySelector('.timing-position');
        const sector = element.querySelector('.timing-sector');
        const speed = element.querySelector('.timing-speed');
        const carNumber = element.querySelector('.timing-car-number');

        let hasChanges = false;

        if (position.textContent !== `P${car.position}`) {
            position.textContent = `P${car.position}`;
            hasChanges = true;
        }

        if (sector.textContent !== (car.sector || 'S1')) {
            sector.textContent = car.sector || 'S1';
        }

        if (speed.textContent !== `${car.speed}%`) {
            speed.textContent = `${car.speed}%`;
            hasChanges = true;
        }

        // Update car color from leaderboard
        const leaderboardEntry = this.currentData.leaderboard.find(entry => entry.car === car.id);
        const carColor = leaderboardEntry ? leaderboardEntry.color : '#666666';
        if (carNumber.style.backgroundColor !== carColor) {
            carNumber.style.backgroundColor = carColor;
        }

        if (hasChanges) {
            element.classList.add('updating');
            setTimeout(() => {
                element.classList.remove('updating');
            }, 300);
        }
    }

    updateStats(data) {
        // Calculate total laps completed
        const totalLaps = data.leaderboard.reduce((sum, entry) => sum + entry.laps, 0);
        this.updateStatValue(this.elements.totalLapsCompleted, totalLaps);

        // Find fastest lap
        const fastestLap = data.leaderboard
            .filter(entry => entry.bestLap && entry.bestLap !== '--:--:---')
            .reduce((fastest, entry) => {
                return !fastest || entry.bestLap < fastest ? entry.bestLap : fastest;
            }, null);
        this.updateStatValue(this.elements.fastestLap, fastestLap || '--:--:---');

        // Race duration
        this.updateStatValue(this.elements.raceDuration, this.formatDuration(data.race.time));

        // Active cars
        const activeCars = data.leaderboard.length;
        this.updateStatValue(this.elements.activeCars, activeCars);
    }

    updateStatValue(element, newValue) {
        if (element.textContent !== newValue.toString()) {
            element.classList.add('updating');
            element.textContent = newValue;
            
            setTimeout(() => {
                element.classList.remove('updating');
            }, 300);
        }
    }

    updateConnectionStatus(connected, message) {
        this.isConnected = connected;
        this.elements.connectionStatus.className = `status-indicator ${connected ? 'connected' : ''}`;
        this.elements.connectionText.textContent = message;
    }

    updateLastUpdateTime() {
        if (this.lastUpdate) {
            this.elements.lastUpdate.textContent = this.lastUpdate.toLocaleTimeString();
        }
    }

    showNoConnectionMessage() {
        // Vider l'affichage quand il n'y a pas de connexion
        this.elements.leaderboard.innerHTML = '';
        this.elements.timingGrid.innerHTML = '';
        // Le statut de connexion WebSocket est déjà affiché dans l'interface
    }

    showWelcomeMessage() {
        // Le statut de connexion WebSocket gère déjà l'affichage
        // Plus besoin d'afficher un message spécial après 2 secondes
    }

    formatTime(milliseconds) {
        const totalSeconds = Math.floor(milliseconds / 1000);
        const minutes = Math.floor(totalSeconds / 60);
        const seconds = totalSeconds % 60;
        const ms = milliseconds % 1000;
        
        return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}.${ms.toString().padStart(3, '0')}`;
    }

    formatDuration(milliseconds) {
        const totalSeconds = Math.floor(milliseconds / 1000);
        const hours = Math.floor(totalSeconds / 3600);
        const minutes = Math.floor((totalSeconds % 3600) / 60);
        const seconds = totalSeconds % 60;
        
        if (hours > 0) {
            return `${hours}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
        } else {
            return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
        }
    }

    formatTime(milliseconds) {
        if (!milliseconds || milliseconds <= 0) return '--:--:---';
        
        const minutes = Math.floor(milliseconds / 60000);
        const seconds = Math.floor((milliseconds % 60000) / 1000);
        const ms = milliseconds % 1000;
        
        return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}.${ms.toString().padStart(3, '0')}`;
    }

    // ========== WEBSOCKET METHODS ==========

    connectWebSocket() {
        if (this.websocket && (this.websocket.readyState === WebSocket.OPEN || this.websocket.readyState === WebSocket.CONNECTING)) {
            return; // Already connected or connecting
        }

        // Check URL parameter for custom IP, otherwise use current hostname
        const urlParams = new URLSearchParams(window.location.search);
        const customIP = urlParams.get('wsip');
        const hostname = customIP || window.location.hostname;
        const wsUrl = `ws://${hostname}:${this.wsPort}`;

        console.log(`🔌 Attempting to connect WebSocket on fixed port ${this.wsPort}:`, wsUrl);
        this.updateConnectionStatus(false, `Connexion au WebSocket (port ${this.wsPort})...`);

        try {
            this.websocket = new WebSocket(wsUrl);

            this.websocket.onopen = () => {
                console.log(`✅ WebSocket connected successfully on port ${this.wsPort}`);
                this.updateConnectionStatus(true, `Connecté au WebSocket (port ${this.wsPort})`);

                // Reset reconnect delay on successful connection
                this.reconnectDelay = 1000;

                // Send ping to test connection
                this.websocket.send('ping');
            };

            this.websocket.onmessage = (event) => {
                try {
                    console.log('📨 Raw WebSocket data received:', event.data);
                    const message = JSON.parse(event.data);
                    console.log('📨 Parsed WebSocket message:', {
                        type: message.type,
                        hasData: !!message.data,
                        timestamp: message.timestamp,
                        leaderboardCount: message.data?.leaderboard?.length
                    });
                    
                    if (message.type === 'race_data' && message.data) {
                        console.log('✅ Processing race_data with', message.data.leaderboard?.length || 0, 'leaderboard entries');
                        // Debug: Log first entry's data to check throttle/button/paid
                        if (message.data.leaderboard && message.data.leaderboard.length > 0) {
                            const firstEntry = message.data.leaderboard[0];
                            console.log('🔍 First entry debug:', {
                                car: firstEntry.car,
                                throttle: firstEntry.throttle,
                                buttonPressed: firstEntry.buttonPressed,
                                hasPaid: firstEntry.hasPaid,
                                blocked: firstEntry.blocked,
                                manuallyBlocked: firstEntry.manuallyBlocked,
                                manuallyUnblocked: firstEntry.manuallyUnblocked
                            });
                        }
                        this.handleDataUpdate(message.data);
                    } else if (message.type === 'pong') {
                        console.log('🏓 WebSocket ping/pong successful');
                    } else {
                        console.warn('⚠️ Unknown message type or missing data, trying direct handling');
                        // Direct data (for backward compatibility)
                        this.handleDataUpdate(message);
                    }
                } catch (error) {
                    console.error('❌ Error parsing WebSocket message:', error);
                    console.error('Raw event data:', event.data);
                }
            };

            this.websocket.onclose = (event) => {
                console.log(`🔌 WebSocket disconnected from port ${this.wsPort}:`, event.code, event.reason);
                this.updateConnectionStatus(false, 'WebSocket déconnecté');

                // Schedule reconnection
                this.scheduleReconnect();
            };

            this.websocket.onerror = (error) => {
                console.error(`❌ WebSocket error on port ${this.wsPort}:`, error);
                this.websocket = null; // Clean up failed connection

                console.warn(`🚫 WebSocket connection failed on port ${this.wsPort}`);
                this.updateConnectionStatus(false, `Serveur WebSocket indisponible sur le port ${this.wsPort} - vérifiez les paramètres`);
                this.showWebSocketInfo();
                this.scheduleReconnect(); // Retry same port after delay
            };

        } catch (error) {
            console.error('❌ Failed to create WebSocket:', error);
            this.updateConnectionStatus(false, 'Échec WebSocket - serveur non disponible');
            this.showWebSocketInfo();
        }
    }

    scheduleReconnect() {
        if (!this.isConnected) {
            console.log(`🔄 Scheduling reconnection to port ${this.wsPort} in ${this.reconnectDelay}ms...`);
            setTimeout(() => {
                if (!this.isConnected) {
                    console.log('🔄 Attempting WebSocket reconnection...');
                    this.connectWebSocket();
                }
            }, this.reconnectDelay);
            
            // Exponential backoff with max limit
            this.reconnectDelay = Math.min(this.reconnectDelay * 1.5, this.maxReconnectDelay);
        }
    }

    disconnectWebSocket() {
        if (this.websocket) {
            console.log('🔌 Disconnecting WebSocket...');
            this.websocket.close();
            this.websocket = null;
        }
    }

    showWebSocketInfo() {
        const infoPanel = document.getElementById('websocketInfo');
        if (infoPanel) {
            infoPanel.style.display = 'block';
            
            // Auto-hide after 10 seconds
            setTimeout(() => {
                infoPanel.style.display = 'none';
            }, 10000);
        }
    }
}

// Initialize the race display when the page loads
document.addEventListener('DOMContentLoaded', () => {
    window.raceDisplay = new RaceDisplay();
});

// Expose for debugging
window.RaceDisplay = RaceDisplay;