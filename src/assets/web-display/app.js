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
        this.isRaceFinished = data.race?.status === 'finished';

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
            'ready': 'EN PRÉPARATION',
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

        // Create a map of existing entries by car number (stored in dataset)
        const existingMap = new Map();
        existingEntries.forEach(entry => {
            const carNum = entry.dataset.carNumber;
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
            const carNum = entry.dataset.carNumber;
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

        const needsPayment = !entry.manuallyBlocked && !entry.manuallyUnblocked && !entry.hasPaid;
        // Si la course est terminée, ne pas afficher l'overlay de blocage
        const isBlocked = !this.isRaceFinished && (entry.manuallyBlocked || entry.blocked);

        const carImageContent = entry.carImage
            ? `<img src="cars/${entry.carImage}" alt="Car ${entry.car}">`
            : '';

        // Texte noir pour les positions 1-3 (podium), blanc pour le reste
        const throttleTextColor = (entry.position >= 1 && entry.position <= 3) ? 'black' : 'white';

        entryElement.innerHTML = `
            <div class="position">${entry.position}</div>
            <div class="car-number" style="background-color: ${entry.color}">${entry.car}</div>
            <div class="car-image">${carImageContent}</div>
            <div class="driver-name">${entry.driver || `Car ${entry.car}`}</div>
            <div class="lap-count">${entry.laps}</div>
            <div class="time">${this.formatTime(entry.time || 0)}</div>
            <div class="gap">${entry.gap || '--'}</div>
            <div class="last-lap">${entry.lastLap || '--:--:---'}</div>
            <div class="best-lap">${entry.bestLap || '--:--:---'}</div>
            <div class="pits">${entry.pits || 0}</div>
            <div class="throttle-status">
                <svg class="throttle-gauge" viewBox="0 0 50 30" xmlns="http://www.w3.org/2000/svg">
                    <path class="throttle-bg" d="M 5 25 A 20 20 0 0 1 45 25" fill="none" stroke="rgba(255,255,255,0.1)" stroke-width="4" stroke-linecap="round"/>
                    <path class="throttle-fill"
                        d="${this.getThrottleArcPath(entry.throttle || 0)}"
                        fill="none"
                        stroke="${this.getThrottleColorRGB(entry.throttle || 0)}"
                        stroke-width="4"
                        stroke-linecap="round"/>
                    <text class="throttle-text" x="25" y="28" text-anchor="middle" fill="${throttleTextColor}" font-size="10" font-weight="bold">${Math.round(entry.throttle || 0)}%</text>
                </svg>
                <div class="button-indicator ${entry.buttonPressed ? 'pressed' : 'released'}">
                    ${entry.buttonPressed ? '●' : '○'}
                </div>
            </div>
            <div class="brake-wear">
                <svg class="brake-icon-svg" viewBox="0 0 256 256" xmlns="http://www.w3.org/2000/svg">
                    <path fill="${this.getBrakeColorRGB(entry.brakeWear !== undefined ? entry.brakeWear : 15)}" d="M151.1,9.7L131.8,29c6.6,10.4,13.2,20.7,19.8,31.1c14.7,14.7,29.4,29.4,44,44c10.4,6.6,20.7,13.2,31.1,19.8l19.3-19.3l-34.8-60.1L151.1,9.7L151.1,9.7z M235,129.5c1.1,30.2-9.8,60.8-32.9,83.8c-43.9,43.9-115.2,43.9-159.2,0C-1,169.4-1,98.1,43,54.1C66.1,31,96.8,20.1,127.1,21.3l-4.9,4.9l24.4,38.2l0.7,0.7c14.7,14.7,29.4,29.4,44,44l0.7,0.7l38.3,24.4L235,129.5L235,129.5z M46.4,134.3c2-1.6,2.3-4.5,0.7-6.5l-15.6-19.4c-1.6-2-4.5-2.3-6.5-0.7l-0.1,0c-2,1.6-2.3,4.5-0.7,6.5l15.6,19.4C41.4,135.6,44.4,136,46.4,134.3L46.4,134.3z M89.7,66.1L99,42c0.9-2.4-0.3-5.1-2.6-6l-0.1,0c-2.4-0.9-5.1,0.3-6,2.6L81,62.7c-0.9,2.4,0.3,5.1,2.6,6l0.1,0C86.1,69.7,88.8,68.5,89.7,66.1z M197.3,138.7l16.3,20.3c1.6,2,4.5,2.3,6.5,0.7l0.1-0.1c2-1.6,2.3-4.5,0.7-6.5l-16.4-20.3c-1.6-2-4.5-2.3-6.5-0.7l-0.1,0C196,133.8,195.7,136.7,197.3,138.7z M155.4,201.6l-9.5,24.4c-0.9,2.4,0.3,5.1,2.6,6l0.1,0c2.4,0.9,5.1-0.3,6-2.6l9.5-24.4c0.9-2.4-0.3-5.1-2.6-6l-0.1,0C159,198,156.3,199.2,155.4,201.6z M80.9,196l-26,4c-2.5,0.4-4.2,2.7-3.9,5.3l0,0.1c0.4,2.5,2.7,4.3,5.3,3.9l26-4c2.5-0.4,4.2-2.7,3.9-5.3l0-0.1C85.7,197.3,83.4,195.5,80.9,196z M153.5,102.7c-2.3-2.3-6-2.3-8.3,0c-2.3,2.3-2.3,6,0,8.3c2.3,2.3,6,2.3,8.3,0C155.8,108.8,155.8,105,153.5,102.7L153.5,102.7z M111.2,91.4c-3.1,0.8-5,4.1-4.2,7.2c0.8,3.1,4.1,5,7.2,4.1c3.1-0.8,5-4.1,4.2-7.2C117.6,92.4,114.4,90.6,111.2,91.4L111.2,91.4z M80.3,122.4c-0.8,3.1,1,6.4,4.1,7.2c3.1,0.8,6.4-1,7.2-4.2c0.8-3.1-1-6.4-4.2-7.2C84.3,117.4,81.1,119.3,80.3,122.4L80.3,122.4z M91.6,164.7c2.3,2.3,6,2.3,8.3,0c2.3-2.3,2.3-6,0-8.3c-2.3-2.3-6-2.3-8.3,0C89.3,158.7,89.3,162.4,91.6,164.7L91.6,164.7z M133.9,176c3.1-0.8,5-4.1,4.1-7.2c-0.8-3.1-4-5-7.2-4.2c-3.1,0.8-5,4.1-4.2,7.2C127.6,175,130.8,176.9,133.9,176L133.9,176z M164.9,145.1c0.8-3.1-1-6.4-4.1-7.2c-3.1-0.8-6.4,1-7.2,4.1c-0.8,3.1,1,6.4,4.2,7.2C160.8,150,164.1,148.2,164.9,145.1L164.9,145.1z M167.3,88.9c-12.2-12.2-28.3-18.4-44.4-18.4c-16.1,0-32.1,6.1-44.4,18.4c-12.3,12.3-18.4,28.3-18.4,44.4c0,16.1,6.1,32.1,18.4,44.4c12.2,12.2,28.3,18.4,44.4,18.4c16,0,32.1-6.1,44.4-18.4c12.3-12.3,18.4-28.3,18.4-44.4C185.6,117.2,179.5,101.1,167.3,88.9L167.3,88.9z M173.2,133.2c0,12.9-4.9,25.7-14.7,35.6c-9.8,9.8-22.7,14.7-35.5,14.7c-12.9,0-25.7-4.9-35.5-14.7c-9.8-9.8-14.7-22.7-14.7-35.6c0-12.9,4.9-25.7,14.7-35.5C97.2,87.9,110,83,122.9,83c12.9,0,25.7,4.9,35.5,14.7C168.3,107.5,173.2,120.4,173.2,133.2L173.2,133.2z M105.3,116.4c-9.5,9.5-9.5,25,0,34.6c9.5,9.5,25,9.5,34.6,0c9.5-9.5,9.5-25,0-34.6C130.3,106.9,114.8,106.9,105.3,116.4z"/>
                </svg>
            </div>
            <div class="fuel-gauge">
                <svg class="fuel-icon-svg" viewBox="0 0 256 256" xmlns="http://www.w3.org/2000/svg">
                    <path fill="${this.getFuelColorRGB(entry.fuel || 0)}" d="M145.5,10.8c-6.2,1.3-9.4,3.4-21.7,14.2c-6.2,5.5-12.2,10.6-13.4,11.3c-3.8,2.5-7.1,3.2-15,3.2c-4.4,0-7.5,0.2-8.3,0.6c-1.1,0.5-1.4,0.2-7.1-5.3c-3.2-3.2-6.4-5.9-6.9-6.1c-2.8-0.9-3.4-0.4-19.1,15.3L39.1,59.1v2c0,2,0.1,2.1,6.5,8.6l6.5,6.6l-1,1.2l-1,1.2v71c0,70.4,0,71.1,1,74.5c2.1,7.7,8,14.8,15.2,18.4c7,3.4,3.7,3.3,67.3,3.3c63.4,0,60.3,0.1,67.1-3.2c8.1-4,14.2-11.9,15.9-20.6c0.4-2,0.5-27.5,0.4-95.9l-0.1-93.1l-1.2-3.4c-3.5-9.6-12.1-17.2-21.8-19.2C189.1,9.7,150,9.8,145.5,10.8z M191,31.4c1.5,1.5,1.6,1.8,1.4,3.5c-0.1,1.2-0.7,2.3-1.4,3.1l-1.2,1.2l-16,0.1c-8.8,0.1-16.5,0-17.1-0.1c-3.4-0.8-4.5-5.6-2-8.1l1.3-1.3h16.7h16.7L191,31.4z M112,124.2l21.6,21.6l21.6-21.6c21.4-21.4,21.6-21.5,23.4-21.5c3.4,0,5.9,3.3,4.8,6.3c-0.3,0.7-9.7,10.5-21.7,22.5l-21.2,21.2l21.2,21.2c14.7,14.7,21.3,21.7,21.7,22.7c0.4,1.2,0.3,1.8-0.4,3.2c-1,2.2-2.6,3-4.9,2.7c-1.7-0.2-3.3-1.7-23.2-21.6l-21.3-21.3l-21.1,21c-11.6,11.6-21.6,21.3-22.1,21.6c-1.8,0.9-3.7,0.6-5.3-0.8c-1.3-1.2-1.5-1.7-1.5-3.5v-2.1l21.6-21.6l21.5-21.5l-21-21c-11.5-11.5-21.3-21.6-21.7-22.3c-1.6-3,0.9-6.7,4.6-6.7C90.4,102.7,90.5,102.7,112,124.2z"/>
                </svg>
            </div>
            <div class="car-status">${this.getCombinedStatus(entry)}</div>
            ${isBlocked ? '<div class="blocked-overlay">Contrôles Désactivés</div>' : ''}
            ${!isBlocked && needsPayment ? '<div class="payment-overlay">Paiement en attente...</div>' : ''}
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

    getCombinedStatus(entry) {
        // Priorité: Fini > Au stand > Rien
        if (entry.finished) return '🏁';
        if (entry.pit) {
            return entry.refuel ? '⛽ REFUEL' : '🔧 PIT';
        }
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

    getBrakeColorRGB(brakeWear) {
        // Dégradé du vert au rouge basé sur l'usure (15 = vert neuf, 0 = rouge critique)
        // Normaliser entre 0 et 1
        const normalized = Math.max(0, Math.min(15, brakeWear)) / 15;

        // Interpoler entre rouge (0) et vert clair (15)
        // Rouge HUN: #fe4637 (254, 70, 55)
        // Vert clair HUN: #8ce06b (140, 224, 107) - green-light
        const redStart = { r: 254, g: 70, b: 55 };
        const greenEnd = { r: 140, g: 224, b: 107 };

        // Interpolation linéaire RGB
        const r = Math.round(redStart.r + (greenEnd.r - redStart.r) * normalized);
        const g = Math.round(redStart.g + (greenEnd.g - redStart.g) * normalized);
        const b = Math.round(redStart.b + (greenEnd.b - redStart.b) * normalized);

        return `rgb(${r}, ${g}, ${b})`;
    }

    getFuelColorRGB(fuel) {
        // Dégradé du rouge au vert basé sur le niveau d'essence (15 = plein, 0 = vide)
        // Normaliser entre 0 et 1
        const normalized = Math.max(0, Math.min(15, fuel)) / 15;

        // Interpoler entre rouge (0) et vert clair (15)
        // Rouge HUN: #fe4637 (254, 70, 55)
        // Vert clair HUN: #8ce06b (140, 224, 107) - green-light
        const redStart = { r: 254, g: 70, b: 55 };
        const greenEnd = { r: 140, g: 224, b: 107 };

        // Interpolation linéaire RGB
        const r = Math.round(redStart.r + (greenEnd.r - redStart.r) * normalized);
        const g = Math.round(redStart.g + (greenEnd.g - redStart.g) * normalized);
        const b = Math.round(redStart.b + (greenEnd.b - redStart.b) * normalized);

        return `rgb(${r}, ${g}, ${b})`;
    }

    getThrottleColorRGB(throttle) {
        // Dégradé pour l'accélérateur
        // 0-70% : vert
        // 70-75% : vert à jaune/orange (zone d'avertissement)
        // 75-100% : orange à rouge (zone critique)
        const percentage = Math.max(0, Math.min(100, throttle));

        // Vert clair HUN: #8ce06b (140, 224, 107)
        // Orange: #ff8c42 (255, 140, 66)
        // Rouge HUN: #fe4637 (254, 70, 55)

        if (percentage <= 70) {
            // 0-70% : Vert pur
            return 'rgb(140, 224, 107)';
        } else if (percentage <= 75) {
            // 70-75% : Vert → Orange
            const normalized = (percentage - 70) / 5; // 0 à 1
            const greenStart = { r: 140, g: 224, b: 107 };
            const orangeEnd = { r: 255, g: 140, b: 66 };

            const r = Math.round(greenStart.r + (orangeEnd.r - greenStart.r) * normalized);
            const g = Math.round(greenStart.g + (orangeEnd.g - greenStart.g) * normalized);
            const b = Math.round(greenStart.b + (orangeEnd.b - greenStart.b) * normalized);

            return `rgb(${r}, ${g}, ${b})`;
        } else {
            // 75-100% : Orange → Rouge
            const normalized = (percentage - 75) / 25; // 0 à 1
            const orangeStart = { r: 255, g: 140, b: 66 };
            const redEnd = { r: 254, g: 70, b: 55 };

            const r = Math.round(orangeStart.r + (redEnd.r - orangeStart.r) * normalized);
            const g = Math.round(orangeStart.g + (redEnd.g - orangeStart.g) * normalized);
            const b = Math.round(orangeStart.b + (redEnd.b - orangeStart.b) * normalized);

            return `rgb(${r}, ${g}, ${b})`;
        }
    }

    getThrottleArcPath(throttle) {
        // Semi-cercle de gauche (0%) à droite (100%)
        const percentage = Math.max(0, Math.min(100, throttle));

        if (percentage === 0) {
            return 'M 5 25'; // Pas d'arc si 0%
        }

        const angle = (percentage / 100) * Math.PI; // 0 à PI (180 degrés)
        const radius = 20;
        const centerX = 25;
        const centerY = 25;

        const startX = 5; // Point de départ à gauche
        const startY = 25;

        // Calculer le point final en suivant l'arc
        const endX = centerX - radius * Math.cos(angle);
        const endY = centerY - radius * Math.sin(angle);

        const largeArcFlag = 0; // Toujours le petit arc pour un semi-cercle

        return `M ${startX} ${startY} A ${radius} ${radius} 0 ${largeArcFlag} 1 ${endX.toFixed(2)} ${endY.toFixed(2)}`;
    }

    updateLeaderboardEntry(element, entry, index) {
        const position = element.querySelector('.position');
        const carNumber = element.querySelector('.car-number');
        const carImage = element.querySelector('.car-image');
        const driverName = element.querySelector('.driver-name');
        const lapCount = element.querySelector('.lap-count');
        const lastLap = element.querySelector('.last-lap');
        const bestLap = element.querySelector('.best-lap');
        const gap = element.querySelector('.gap');
        const time = element.querySelector('.time');
        const pits = element.querySelector('.pits');
        const carStatus = element.querySelector('.car-status');

        let hasChanges = false;

        // Update car number (always present)
        if (carNumber.style.backgroundColor !== entry.color) {
            carNumber.style.backgroundColor = entry.color;
        }
        if (carNumber.textContent !== entry.car.toString()) {
            carNumber.textContent = entry.car;
        }

        // Update car image (container always exists)
        if (entry.carImage) {
            const img = carImage.querySelector('img');
            if (!img) {
                // Add image if it doesn't exist
                carImage.innerHTML = `<img src="cars/${entry.carImage}" alt="Car ${entry.car}">`;
                hasChanges = true;
            } else {
                // Update image src if changed
                const currentSrc = img.getAttribute('src');
                const newSrc = `cars/${entry.carImage}`;
                if (currentSrc !== newSrc) {
                    img.src = newSrc;
                    hasChanges = true;
                }
            }
        } else {
            // Remove image if no carImage
            if (carImage.innerHTML !== '') {
                carImage.innerHTML = '';
                hasChanges = true;
            }
        }

        // Handle blocked overlay - ne pas afficher si la course est terminée
        const isBlocked = !this.isRaceFinished && (entry.manuallyBlocked || entry.blocked);
        let blockedOverlay = element.querySelector('.blocked-overlay');

        if (isBlocked && !blockedOverlay) {
            // Add blocked overlay if needed
            blockedOverlay = document.createElement('div');
            blockedOverlay.className = 'blocked-overlay';
            blockedOverlay.textContent = 'Contrôles Désactivés';
            element.appendChild(blockedOverlay);
        } else if (!isBlocked && blockedOverlay) {
            // Remove blocked overlay if no longer needed
            blockedOverlay.remove();
        }

        // Handle payment overlay (only if not blocked)
        const needsPayment = !entry.manuallyBlocked && !entry.manuallyUnblocked && !entry.hasPaid;
        let paymentOverlay = element.querySelector('.payment-overlay');

        if (!isBlocked && needsPayment && !paymentOverlay) {
            // Add payment overlay if needed
            paymentOverlay = document.createElement('div');
            paymentOverlay.className = 'payment-overlay';
            paymentOverlay.textContent = 'Paiement en attente...';
            element.appendChild(paymentOverlay);
        } else if ((isBlocked || !needsPayment) && paymentOverlay) {
            // Remove payment overlay if no longer needed
            paymentOverlay.remove();
        }

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

        // Update fuel gauge - changer la couleur du SVG
        const fuelIconSvg = element.querySelector('.fuel-icon-svg path');
        if (fuelIconSvg) {
            const fuelValue = entry.fuel || 0;
            const newFuelColor = this.getFuelColorRGB(fuelValue);

            if (fuelIconSvg.getAttribute('fill') !== newFuelColor) {
                fuelIconSvg.setAttribute('fill', newFuelColor);
                hasChanges = true;
            }
        }

        // Update throttle gauge SVG
        const throttleStatus = element.querySelector('.throttle-status');
        if (throttleStatus) {
            const throttlePercentage = Math.max(0, Math.min(100, entry.throttle || 0));
            const throttleGauge = throttleStatus.querySelector('.throttle-gauge');
            const buttonIndicator = throttleStatus.querySelector('.button-indicator');

            if (throttleGauge) {
                const throttleFillPath = throttleGauge.querySelector('.throttle-fill');
                const throttleText = throttleGauge.querySelector('.throttle-text');

                if (throttleFillPath) {
                    const newColor = this.getThrottleColorRGB(throttlePercentage);
                    const newPath = this.getThrottleArcPath(throttlePercentage);

                    if (throttleFillPath.getAttribute('stroke') !== newColor) {
                        throttleFillPath.setAttribute('stroke', newColor);
                    }
                    if (throttleFillPath.getAttribute('d') !== newPath) {
                        throttleFillPath.setAttribute('d', newPath);
                    }
                }

                if (throttleText) {
                    const newText = `${Math.round(throttlePercentage)}%`;
                    const newTextColor = (entry.position >= 1 && entry.position <= 3) ? 'black' : 'white';

                    if (throttleText.textContent !== newText) {
                        throttleText.textContent = newText;
                    }
                    if (throttleText.getAttribute('fill') !== newTextColor) {
                        throttleText.setAttribute('fill', newTextColor);
                    }
                }
            }

            // Update button indicator
            if (buttonIndicator) {
                const buttonClass = entry.buttonPressed ? 'pressed' : 'released';
                const buttonSymbol = entry.buttonPressed ? '●' : '○';
                if (!buttonIndicator.classList.contains(buttonClass)) {
                    buttonIndicator.className = `button-indicator ${buttonClass}`;
                    buttonIndicator.textContent = buttonSymbol;
                }
            }
        }


        // Update combined status (pit + car status)
        const newCombinedStatus = this.getCombinedStatus(entry);
        if (carStatus.textContent !== newCombinedStatus) {
            carStatus.textContent = newCombinedStatus;
            hasChanges = true;
        }

        // Update brake wear - changer la couleur du SVG
        const brakeIconSvg = element.querySelector('.brake-icon-svg path');
        if (brakeIconSvg) {
            const brakeWearValue = entry.brakeWear !== undefined ? entry.brakeWear : 15;
            const newColor = this.getBrakeColorRGB(brakeWearValue);

            if (brakeIconSvg.getAttribute('fill') !== newColor) {
                brakeIconSvg.setAttribute('fill', newColor);
                hasChanges = true;
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

        // Si l'élément n'existe pas (section supprimée), ignorer
        if (!container) {
            return;
        }

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
        // Section stats supprimée - ignorer si les éléments n'existent pas
        if (!this.elements.totalLapsCompleted) {
            return;
        }

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
        if (!element) return;

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
                        // Debug: Log first entry's data to check throttle/button/paid/carImage
                        if (message.data.leaderboard && message.data.leaderboard.length > 0) {
                            const firstEntry = message.data.leaderboard[0];
                            console.log('🔍 First entry debug:', {
                                car: firstEntry.car,
                                driver: firstEntry.driver,
                                carImage: firstEntry.carImage,
                                color: firstEntry.color,
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