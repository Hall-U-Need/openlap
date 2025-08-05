import { Injectable, OnDestroy } from '@angular/core';
import { Platform } from '@ionic/angular';
import { BehaviorSubject, Observable, Subscription, combineLatest } from 'rxjs';
import { map, distinctUntilChanged, take } from 'rxjs/operators';

import { LoggingService } from './logging.service';
import { AppSettings } from '../app-settings';
import { ControlUnitService } from './control-unit.service';
import { ExternalApiService } from './external-api.service';
import { Session } from '../rms/session';
import { Entry } from '../rms/session';

interface WebDisplayData {
  race: {
    mode: string;
    status: string;
    time: number;
    laps: number;
    currentLap: number;
  };
  leaderboard: Array<{
    position: number;
    car: number;
    driver: string;
    laps: number;
    lastLap: string;
    bestLap: string;
    gap: string;
    color: string;
    fuel: number;
    pit: boolean;
    finished: boolean;
    pits: number;
    refuel: boolean;
    time: number;
    throttle: number;
    buttonPressed: boolean;
    hasPaid: boolean;
    blocked: boolean;
    manuallyUnblocked: boolean;
    manuallyBlocked: boolean;
  }>;
  realtime: {
    timestamp: number;
    bestLap: number;
    totalLaps: number;
    activeCars: number;
    cars?: Array<{
      id: number;
      speed: number;
      position: number;
      sector: string;
    }>;
  };
}

@Injectable({
  providedIn: 'root'
})
export class WebDisplayService implements OnDestroy {
  private server: any;
  private isServerRunning = false;
  private port = 8080;
  private enabled = false;
  
  private dataSubject = new BehaviorSubject<WebDisplayData>({
    race: {
      mode: 'practice',
      status: 'stopped',
      time: 0,
      laps: 0,
      currentLap: 0
    },
    leaderboard: [],
    realtime: {
      timestamp: Date.now(),
      bestLap: 0,
      totalLaps: 0,
      activeCars: 0,
      cars: []
    }
  });

  private connectedClients = new Set<any>();
  private wsServer: any;
  private wsPort = 8081;
  private serverStatusSubject = new BehaviorSubject<boolean>(false);
  private mdnsServiceName = 'OpenLap Race Display';
  private mdnsServiceType = '_http._tcp.';
  private localHostname = 'openlap.local';
  private localIPAddress: string | null = null;
  private sessionSubscription?: Subscription;
  private currentSession?: Session;
  private pitfuel: number[] = [];
  private broadcastThrottleTimer: any = null;
  private pendingBroadcast = false;

  public data$ = this.dataSubject.asObservable();
  public serverStatus$ = this.serverStatusSubject.asObservable();

  constructor(
    private platform: Platform,
    private logger: LoggingService,
    private settings: AppSettings,
    private controlUnitService: ControlUnitService,
    private externalApi: ExternalApiService
  ) {
    // Écouter les changements de configuration
    this.settings.getWebDisplay().subscribe(config => {
      const wasEnabled = this.enabled;
      this.enabled = config.enabled;
      this.port = config.port;
      
      this.logger.info('Web Display configuration updated:', {
        enabled: this.enabled,
        port: this.port
      });
      
      // Redémarrer le serveur si nécessaire
      if (this.enabled && !wasEnabled) {
        this.startServer();
      } else if (!this.enabled && wasEnabled) {
        this.stopServer();
      } else if (this.enabled && this.isServerRunning && config.port !== this.port) {
        this.stopServer();
        this.startServer();
      }
      
      // Déclencher une mise à jour des données si le serveur est en marche
      if (this.enabled && this.isServerRunning) {
        this.logger.info('🔄 Web Display config changed - updating data...');
        this.ensureDataConnection();
      }
    });

    // Écouter les changements de pilotes pour mettre à jour l'affichage
    this.settings.getDrivers().subscribe(drivers => {
      this.logger.info('🔔 Drivers changed, count:', drivers.length, 'server running:', this.isServerRunning);
      if (this.isServerRunning) {
        this.logger.info('🔄 Drivers changed - reconnecting to live data...');
        this.ensureDataConnection();
      }
    });

    // Écouter les connexions/déconnexions de ControlUnit
    this.controlUnitService.asObservable().subscribe(controlUnit => {
      this.logger.info('🎛️ ControlUnit changed:', {
        hasControlUnit: !!controlUnit,
        controlUnitType: controlUnit?.constructor?.name,
        serverRunning: this.isServerRunning
      });
      
      if (this.isServerRunning) {
        this.logger.info('🔄 ControlUnit changed - ensuring data connection...');
        this.ensureDataConnection();
      }
    });
  }

  async startServer(): Promise<boolean> {
    if (!this.enabled || this.isServerRunning) {
      return false;
    }

    try {
      // Obtenir l'adresse IP locale d'abord
      this.localIPAddress = await this.getLocalIPAddress();
      this.logger.info('Using local IP address:', this.localIPAddress);
      
      if (this.platform.is('cordova')) {
        this.logger.info('Platform is Cordova, checking for httpd plugin...');
        this.logger.info('Available cordova.plugins:', Object.keys((window as any).cordova?.plugins || {}));
        
        // Utiliser le plugin cordova-plugin-httpd si disponible
        if ((window as any).cordova?.plugins?.CorHttpd) {
          this.logger.info('CorHttpd plugin found, starting server...');
          const httpd = (window as any).cordova.plugins.CorHttpd;
          
          const options = {
            www_root: 'assets/web-display',
            port: this.port,
            localhost_only: false,
            // Permettre l'accès aux fichiers depuis d'autres répertoires
            cors: true
          };

          // Vérifier que les fichiers web existent
          this.logger.info('Using www_root: www/web-display for static files');
          this.logger.info('Make sure index.html, styles.css, app.js exist in this directory');

          await new Promise<void>((resolve, reject) => {
            this.logger.info('Starting HTTP server with options:', options);
            
            httpd.startServer(options, 
              (url: string) => {
                this.logger.info('✅ Web Display server started successfully at:', url);
                this.logger.info('Server should be accessible from other devices on the network');
                this.isServerRunning = true;
                this.serverStatusSubject.next(true);
                resolve();
              },
              (error: any) => {
                this.logger.error('❌ Failed to start web display server:', error);
                this.logger.error('Error details:', JSON.stringify(error));
                this.logger.error('Possible causes:');
                this.logger.error('- Port', this.port, 'is already in use');
                this.logger.error('- Insufficient permissions');
                this.logger.error('- Network interface not available');
                reject(error);
              }
            );
          });

          // Créer les endpoints personnalisés pour les données temps réel
          this.setupWebSocketAlternative();
          
          // Publier le service via mDNS/Bonjour
          await this.publishMDNSService();
          
          // Se connecter aux données live du ControlUnit
          this.logger.info('🔧 Web Display initialized - connecting to live data...');
          this.ensureDataConnection();
          
          return true;
        } else {
          this.logger.error('❌ CorHttpd plugin not available - Web Display cannot start');
          this.logger.error('cordova object:', (window as any).cordova ? 'exists' : 'missing');
          this.logger.error('cordova.plugins:', (window as any).cordova?.plugins ? 'exists' : 'missing');
          this.logger.error('The HTTP server plugin is required for Web Display to work');
          this.logger.info('To fix this issue:');
          this.logger.info('1. Install the plugin: cordova plugin add https://github.com/floatinghotpot/cordova-httpd.git');
          this.logger.info('2. Rebuild the app: ionic cordova build android');
          this.logger.info('3. Reinstall on your device');
          
          // NE PAS simuler - indiquer clairement que ça ne fonctionne pas
          return false;
        }
      } else {
        // Mode développement - simuler le serveur
        this.logger.info('Web Display server simulated in browser mode');
        this.isServerRunning = true;
        this.serverStatusSubject.next(true);
        return true;
      }
    } catch (error) {
      this.logger.error('Error starting web display server:', error);
      return false;
    }
  }

  async stopServer(): Promise<void> {
    if (!this.isServerRunning) {
      return;
    }

    try {
      // Arrêter le service mDNS d'abord
      await this.unpublishMDNSService();
      
      // Arrêter le serveur WebSocket
      this.stopWebSocketServer();
      
      if (this.platform.is('cordova') && (window as any).cordova?.plugins?.httpd) {
        const httpd = (window as any).cordova.plugins.httpd;
        
        await new Promise<void>((resolve) => {
          httpd.stopServer(
            () => {
              this.logger.info('Web Display server stopped');
              this.isServerRunning = false;
              this.serverStatusSubject.next(false);
              this.connectedClients.clear();
              resolve();
            },
            (error: any) => {
              this.logger.error('Error stopping server:', error);
              resolve(); // Continuer même en cas d'erreur
            }
          );
        });
      }
    } catch (error) {
      this.logger.error('Error stopping web display server:', error);
    }
  }

  updateRaceData(raceData: Partial<WebDisplayData['race']>): void {
    const currentData = this.dataSubject.value;
    const updatedData = {
      ...currentData,
      race: { ...currentData.race, ...raceData }
    };
    this.dataSubject.next(updatedData);
    this.throttledBroadcast();
  }

  updateLeaderboard(leaderboard: WebDisplayData['leaderboard']): void {
    const currentData = this.dataSubject.value;
    const updatedData = {
      ...currentData,
      leaderboard: leaderboard
    };
    this.dataSubject.next(updatedData);
    this.throttledBroadcast();
  }

  updateRealtime(realtimeData: Partial<WebDisplayData['realtime']>): void {
    const currentData = this.dataSubject.value;
    const updatedData = {
      ...currentData,
      realtime: { 
        ...currentData.realtime, 
        ...realtimeData,
        timestamp: Date.now()
      }
    };
    this.dataSubject.next(updatedData);
    this.throttledBroadcast();
  }

  // Connecter une session de course pour afficher les données réelles (copie de l'interface native)
  connectSession(session: Session, options?: any): void {
    this.logger.info('🏁 Connecting race session to Web Display (native method)');
    
    // Déconnecter la session précédente si elle existe  
    this.disconnectSession();
    
    this.currentSession = session;
    
    // COPIE EXACTE de rms.page.ts - créer les mêmes observables que l'interface native
    const drivers$ = this.settings.getDrivers();
    const order$ = new BehaviorSubject('position'); // Ordre par défaut comme l'interface native
    
    // Vérifier si l'ExternalApiService est actif et le démarrer si nécessaire
    this.logger.info('🔍 Checking ExternalApiService status...');
    
    // Vérifier l'état actuel
    this.externalApi.cars$.pipe(take(1)).subscribe(cars => {
      this.logger.info('🚗 ExternalApiService cars$ status:', { count: cars.length, firstCar: cars[0] });
      if (cars.length === 0) {
        this.logger.warn('⚠️ ExternalApiService seems inactive, trying to start polling...');
        this.externalApi.startPolling();
      }
    });
    
    this.externalApi.coinAcceptors$.pipe(take(1)).subscribe(coins => {
      this.logger.info('🪙 ExternalApiService coinAcceptors$ status:', { count: coins.length });
    });
    
    // Vérifier le statut de polling
    this.externalApi.isPolling$.pipe(take(1)).subscribe(isPolling => {
      this.logger.info('⚙️ ExternalApiService polling status:', isPolling);
      if (!isPolling) {
        this.logger.warn('⚠️ ExternalApiService not polling, starting...');
        this.externalApi.startPolling();
      }
    });
    
    // Créer l'observable items EXACTEMENT comme dans rms.page.ts ligne 272
    const items$ = combineLatest([
      session.ranking, 
      drivers$, 
      order$, 
      this.externalApi.cars$,
      this.externalApi.coinAcceptors$
    ]).pipe(
      map(([ranks, drivers, order, apiCars, coinAcceptors]) => {
        this.logger.info('🎯 Native-style data processing:', {
          ranksCount: ranks.length,
          driversCount: drivers.length,
          order,
          apiCarsCount: apiCars.length,
          coinAcceptorsCount: coinAcceptors.length
        });
        
        // Debug: Log first API car data if available
        if (apiCars.length > 0) {
          this.logger.info('🚗 First API car data:', {
            car_id: apiCars[0].car_id,
            accelerator_percent: apiCars[0].accelerator_percent,
            button_pressed: apiCars[0].button_pressed,
            has_coin: apiCars[0].has_coin,
            active: apiCars[0].active,
            blocked: apiCars[0].blocked
          });
        } else {
          this.logger.warn('⚠️ No API cars data available from ExternalApiService');
        }
        
        // Filter ranks to only include cars that are ACTIVE in ExternalApi
        const activeRanks = ranks.filter(item => {
          const carInfo = apiCars.find(car => car.car_id === item.id + 1);
          const isActive = carInfo && carInfo.active === true;
          if (!isActive) {
            this.logger.info('🚫 Filtering out car', item.id + 1, '- not active in ExternalApi (active:', carInfo?.active, ')');
          }
          return isActive;
        });
        
        this.logger.info('🎯 Filtered ranks:', {
          originalCount: ranks.length,
          filteredCount: activeRanks.length,
          filteredCarIds: activeRanks.map(r => r.id + 1)
        });

        // COPIE EXACTE de la logique rms.page.ts ligne 274-301 (but using filtered ranks)
        const gridpos = [];
        const pitfuel = [];
        const items = activeRanks.map((item, index) => {
          // Track pitfuel for refuel calculation
          if (!item.pit || (item.fuel || 0) < (pitfuel[item.id] || 15)) {
            pitfuel[item.id] = item.fuel || 0;
          }
          
          // Get real-time data from API (EXACTLY like rms.page.ts)
          const carInfo = apiCars.find(car => car.car_id === item.id + 1); // item.id is 0-based, API car_id is 1-based
          const coinInfo = coinAcceptors.find(coin => coin.id === item.id + 1);
          const hasPaid = carInfo ? carInfo.has_coin : (coinInfo ? coinInfo.coin_count > 0 : false);
          
          return Object.assign({}, item, {
            position: index,
            driver: drivers[item.id],
            gridpos: gridpos[item.id],
            refuel: item.pit && (item.fuel || 0) > (pitfuel[item.id] || 0),
            throttle: carInfo ? carInfo.accelerator_percent : 0,
            buttonPressed: carInfo ? carInfo.button_pressed : false,
            hasPaid: hasPaid,
            waitingForPayment: !hasPaid && carInfo && carInfo.active,
            blocked: carInfo ? carInfo.blocked : false,
            manuallyUnblocked: carInfo ? carInfo.manually_unblocked : false,
            manuallyBlocked: carInfo ? carInfo.manually_blocked : false
          });
        });
        
        // Si pas de ranks mais des drivers, créer des entrées initiales SEULEMENT pour les voitures ACTIVES dans l'API
        if (items.length === 0 && drivers.length > 0 && apiCars.length > 0) {
          this.logger.info('📋 No ranks - creating initial entries for ACTIVE cars from ExternalApi');
          
          // Only create entries for cars that are ACTIVE in ExternalApi data
          apiCars.forEach(carInfo => {
            const carIndex = carInfo.car_id - 1; // Convert 1-based to 0-based
            const isValid = carIndex >= 0 && carIndex < drivers.length;
            const isActive = carInfo.active === true;
            
            if (isValid && isActive) {
              this.logger.info('✅ Creating entry for ACTIVE car', carInfo.car_id, 'driver:', drivers[carIndex]?.name);
              items.push({
                id: carIndex,
                position: carIndex,
                driver: drivers[carIndex],
                laps: 0,
                time: 0,
                last: [],
                best: [],
                times: [],
                sector: 0,
                finished: false,
                fuel: 15,
                pit: false,
                // Propriétés requises par le type
                gridpos: undefined,
                refuel: false,
                throttle: 0,
                buttonPressed: false,
                hasPaid: true,
                waitingForPayment: false,
                blocked: false,
                manuallyUnblocked: false,
                manuallyBlocked: false
              });
            } else if (isValid && !isActive) {
              this.logger.info('🚫 Skipping INACTIVE car', carInfo.car_id, 'driver:', drivers[carIndex]?.name);
            }
          });
        }
        
        return items;
      })
    );
    
    // S'abonner aux items comme l'interface native
    this.sessionSubscription = items$.subscribe(items => {
      this.logger.info('✅ Received native-style items:', items.length);
      
      // Debug: Log first item's data to check if throttle/button/paid are present
      if (items.length > 0) {
        const firstItem = items[0];
        this.logger.info('🔍 First item received:', {
          id: firstItem.id,
          throttle: firstItem.throttle,
          buttonPressed: firstItem.buttonPressed,
          hasPaid: firstItem.hasPaid,
          blocked: firstItem.blocked,
          manuallyBlocked: firstItem.manuallyBlocked,
          manuallyUnblocked: firstItem.manuallyUnblocked
        });
      }
      
      this.updateFromNativeItems(items, session, options);
    });
  }

  // Déconnecter la session actuelle
  disconnectSession(): void {
    if (this.sessionSubscription) {
      this.sessionSubscription.unsubscribe();
      this.sessionSubscription = undefined;
    }
    this.currentSession = undefined;
    this.logger.info('🔌 Disconnected race session from Web Display');
    
    // Se reconnecter aux données ControlUnit si le serveur est toujours en marche
    if (this.isServerRunning) {
      this.logger.info('🔄 Reconnecting to live ControlUnit data after session disconnect...');
      this.ensureDataConnection();
    }
  }

  // Mettre à jour les données Web Display à partir des données de session
  private updateFromSession(
    ranking: Entry[], 
    currentLap: number, 
    finished: boolean, 
    yellowFlag: boolean, 
    timer: number,
    drivers: any[],
    options?: any,
    apiCars?: any[],
    coinAcceptors?: any[]
  ): void {
    this.logger.info('🔄 updateFromSession called:', {
      rankingCount: ranking.length,
      currentLap,
      finished,
      yellowFlag,
      timer,
      driversCount: drivers.length,
      driversArray: drivers,
      mode: options?.mode
    });
    // Déterminer le mode de course
    const raceMode = options?.mode || this.currentSession?.options?.mode || 'practice';
    
    // Mettre à jour l'état de la course
    let raceStatus = 'En attente';
    if (finished) {
      raceStatus = 'Terminée';
    } else if (yellowFlag) {
      raceStatus = 'Drapeau jaune';
    } else if (this.currentSession?.started) {
      raceStatus = 'En cours';
    } else if (ranking.length > 0) {
      raceStatus = 'Prêt';
    }
    
    this.updateRaceData({
      mode: raceMode,
      status: raceStatus,
      time: timer,
      currentLap: currentLap,
      laps: options?.laps || this.currentSession?.options?.laps || 0
    });

    // Créer le classement comme l'affichage natif : toujours avec les pilotes configurés
    let leaderboard = [];
    
    if (drivers.length > 0) {
      if (ranking.length > 0) {
        // Cas 1: Il y a des données de ranking - les combiner avec les drivers (comme l'affichage natif)
        this.logger.info('📊 Combining ranking data with', drivers.length, 'configured drivers');
        leaderboard = ranking.slice(0, 8).map((entry, index) => {
          const bestLapTime = entry.best && entry.best.length > 0 ? 
            entry.best.reduce((min, time) => time > 0 && time < min ? time : min, Number.MAX_VALUE) : 0;
          
          const lastLapTime = entry.last && entry.last.length > 0 ? 
            entry.last.reduce((sum, time) => sum + time, 0) : 0;

          // Track pitfuel for refuel calculation (like native display)
          if (!entry.pit || (entry.fuel || 0) < (this.pitfuel[entry.id] || 15)) {
            this.pitfuel[entry.id] = entry.fuel || 0;
          }

          // Utiliser le vrai nom du pilote depuis la configuration (comme l'affichage natif)
          const driverInfo = drivers[entry.id] || {};
          const driverName = driverInfo?.name || `Voiture ${entry.id + 1}`;
          const driverColor = driverInfo?.color || this.getCarColor(entry.id);

          // Get real-time data from API (EXACTLY like connectSession method)
          const carInfo = apiCars ? apiCars.find(car => car.car_id === entry.id + 1) : null;
          const coinInfo = coinAcceptors ? coinAcceptors.find(coin => coin.id === entry.id + 1) : null;
          const hasPaid = carInfo ? carInfo.has_coin : (coinInfo ? coinInfo.coin_count > 0 : true);

          return {
            position: index + 1,
            car: entry.id + 1,
            driver: driverName,
            laps: entry.laps || 0,
            lastLap: this.formatLapTime(lastLapTime),
            bestLap: this.formatLapTime(bestLapTime),
            gap: index === 0 ? '-' : this.calculateGap(ranking[0], entry),
            color: driverColor,
            fuel: entry.fuel || 0,
            pit: entry.pit || false,
            finished: entry.finished || false,
            pits: entry.pits || 0,
            refuel: entry.pit && (entry.fuel || 0) > (this.pitfuel[entry.id] || 0),
            time: entry.time || 0,
            throttle: carInfo ? carInfo.accelerator_percent : 0,
            buttonPressed: carInfo ? carInfo.button_pressed : false,
            hasPaid: hasPaid,
            blocked: carInfo ? carInfo.blocked : false,
            manuallyUnblocked: carInfo ? carInfo.manually_unblocked : false,
            manuallyBlocked: carInfo ? carInfo.manually_blocked : false
          };
        });
      } else {
        // Cas 2: Pas de ranking mais des drivers configurés - créer des entrées initiales (comme l'affichage natif)
        this.logger.info('📋 No ranking data yet, creating entries for', drivers.length, 'configured drivers (native display style)');
        leaderboard = drivers.slice(0, 8).map((driver, index) => ({
          position: index + 1,
          car: index + 1,
          driver: driver?.name || `Voiture ${index + 1}`,
          laps: 0,
          lastLap: '--:--:---',
          bestLap: '--:--:---',
          gap: index === 0 ? '-' : '--',
          color: driver?.color || this.getCarColor(index),
          fuel: 15,
          pit: false,
          finished: false,
          pits: 0,
          refuel: false,
          time: 0,
          throttle: 0,
          buttonPressed: false,
          hasPaid: true,
          blocked: false,
          manuallyUnblocked: false,
          manuallyBlocked: false
        }));
        
        this.logger.info('✅ Created initial entries like native display:', leaderboard.map(entry => `${entry.position}. ${entry.driver}`));
      }
    } else {
      this.logger.warn('❌ No drivers configured! Cannot create leaderboard');
    }

    this.updateLeaderboard(leaderboard);

    // Calculer les statistiques globales
    const allBestTimes = ranking
      .map(entry => entry.best && entry.best.length > 0 ? 
        entry.best.reduce((min, time) => time > 0 && time < min ? time : min, Number.MAX_VALUE) : 0)
      .filter(time => time > 0 && time < Number.MAX_VALUE);
    
    const globalBestLap = allBestTimes.length > 0 ? Math.min(...allBestTimes) : 0;
    const totalLaps = ranking.reduce((sum, entry) => sum + (entry.laps || 0), 0);

    this.updateRealtime({
      bestLap: globalBestLap,
      totalLaps: totalLaps,
      activeCars: ranking.filter(entry => (entry.laps || 0) > 0).length
    });

    this.logger.debug('🔄 Updated Web Display with session data:', {
      ranking: ranking.length,
      currentLap,
      finished,
      yellowFlag,
      drivers: drivers.map(d => d.name || 'Unknown')
    });
  }

  // Formater le temps de tour en minutes:secondes.millisecondes
  private formatLapTime(timeMs: number): string {
    if (!timeMs || timeMs <= 0) return '--:--.---';
    
    const minutes = Math.floor(timeMs / 60000);
    const seconds = Math.floor((timeMs % 60000) / 1000);
    const milliseconds = timeMs % 1000;
    
    return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}.${milliseconds.toString().padStart(3, '0')}`;
  }

  // Calculer l'écart avec le leader
  private calculateGap(leader: Entry, entry: Entry): string {
    if (!leader || !entry || entry.id === leader.id) return '-';
    
    const lapDiff = (leader.laps || 0) - (entry.laps || 0);
    if (lapDiff > 0) {
      return `+${lapDiff} tour${lapDiff > 1 ? 's' : ''}`;
    }
    
    const timeDiff = (entry.time || 0) - (leader.time || 0);
    if (timeDiff > 0) {
      return `+${this.formatLapTime(timeDiff)}`;
    }
    
    return '-';
  }

  // Obtenir la couleur de voiture (peut être personnalisé)
  private getCarColor(carId: number): string {
    const colors = ['Rouge', 'Bleu', 'Vert', 'Jaune', 'Orange', 'Violet', 'Rose', 'Cyan'];
    return colors[carId] || `Voiture ${carId + 1}`;
  }

  // Traiter les données exactement comme l'interface native
  private updateFromNativeItems(items: any[], session: Session, options?: any): void {
    this.logger.info('🎯 Processing native-style items:', items.length);
    this.logger.info('🎯 Options received:', options);
    this.logger.info('🎯 options.drivers setting:', options?.drivers);
    
    // Récupérer les valeurs actuelles des BehaviorSubjects
    let isFinished = false;
    let isYellowFlag = false;
    let currentTimer = 0;
    let currentLap = 0;
    
    // Essayer de récupérer les valeurs si ce sont des BehaviorSubjects
    if (session.finished && (session.finished as any).value !== undefined) {
      isFinished = (session.finished as any).value;
    }
    if (session.yellowFlag && (session.yellowFlag as any).value !== undefined) {
      isYellowFlag = (session.yellowFlag as any).value;
    }
    if (session.timer && (session.timer as any).value !== undefined) {
      currentTimer = (session.timer as any).value;
    }
    if (session.currentLap && (session.currentLap as any).value !== undefined) {
      currentLap = (session.currentLap as any).value;
    }
    
    // Données de course
    this.updateRaceData({
      mode: options?.mode || 'practice',
      status: isFinished ? 'Terminée' : 
              isYellowFlag ? 'Drapeau jaune' : 
              items.length > 0 ? 'En cours' : 'En attente',
      time: currentTimer,
      currentLap: currentLap,
      laps: options?.laps || 0
    });

    // Apply filtering based on ExternalApi active cars - only show cars that are actually detected
    let filteredItems = items;

    // Créer le leaderboard depuis les items filtrés (comme l'interface native)
    const leaderboard = filteredItems.map((item, index) => {
      const bestLapTime = item.best && item.best.length > 0 ? 
        Math.min(...item.best.filter(t => t > 0)) : 0;
      
      const lastLapTime = item.last && item.last.length > 0 ? 
        item.last.reduce((sum, time) => sum + time, 0) : 0;

      return {
        position: index + 1,
        car: item.id + 1,
        driver: item.driver?.name || `Voiture ${item.id + 1}`,
        laps: item.laps || 0,
        lastLap: this.formatLapTime(lastLapTime),
        bestLap: this.formatLapTime(bestLapTime),
        gap: index === 0 ? '-' : this.calculateGapFromItems(items[0], item),
        color: item.driver?.color || this.getCarColor(item.id),
        fuel: item.fuel || 0,
        pit: item.pit || false,
        finished: item.finished || false,
        pits: item.pits || 0,
        refuel: item.refuel || false,
        time: item.time || 0,
        throttle: item.throttle || 0,
        buttonPressed: item.buttonPressed || false,
        hasPaid: item.hasPaid || false,
        blocked: item.blocked || false,
        manuallyUnblocked: item.manuallyUnblocked || false,
        manuallyBlocked: item.manuallyBlocked || false
      };
    });

    this.logger.info('✅ Native-style leaderboard created:', leaderboard.map(entry => `${entry.position}. ${entry.driver}`));
    this.updateLeaderboard(leaderboard);

    // Statistiques basées sur les items filtrés
    const allBestTimes = filteredItems
      .map(item => item.best && item.best.length > 0 ? Math.min(...item.best.filter(t => t > 0)) : 0)
      .filter(time => time > 0);
    
    this.updateRealtime({
      bestLap: allBestTimes.length > 0 ? Math.min(...allBestTimes) : 0,
      totalLaps: filteredItems.reduce((sum, item) => sum + (item.laps || 0), 0),
      activeCars: filteredItems.length,
      cars: filteredItems.map((item, index) => ({
        id: item.id,
        speed: 0,
        position: index + 1,
        sector: item.pit ? 'PIT' : 'PISTE'
      }))
    });
  }

  private calculateGapFromItems(leader: any, item: any): string {
    if (!leader || !item || item.id === leader.id) return '-';
    
    const lapDiff = (leader.laps || 0) - (item.laps || 0);
    if (lapDiff > 0) {
      return `+${lapDiff} tour${lapDiff > 1 ? 's' : ''}`;
    }
    
    const timeDiff = (item.time || 0) - (leader.time || 0);
    if (timeDiff > 0) {
      return `+${this.formatLapTime(timeDiff)}`;
    }
    
    return '-';
  }


  // Mettre à jour l'affichage avec seulement les pilotes configurés (sans session)
  private updateWithDriversOnly(drivers: any[]): void {
    this.logger.info('🎯 updateWithDriversOnly called with', drivers.length, 'drivers');
    
    // Get current ExternalApi data to filter only active cars
    this.externalApi.cars$.pipe(take(1)).subscribe(apiCars => {
      this.logger.info('🚗 Filtering drivers with ExternalApi data:', {
        driversCount: drivers.length,
        apiCarsCount: apiCars.length,
        activeCars: apiCars.map(car => car.car_id)
      });
      
      // Only create leaderboard entries for cars that are ACTIVE in ExternalApi
      const leaderboard = apiCars
        .filter(carInfo => {
          const carIndex = carInfo.car_id - 1;
          const isValid = carIndex >= 0 && carIndex < drivers.length;
          const isActive = carInfo.active === true;
          if (isValid && !isActive) {
            this.logger.info('🚫 Filtering out car', carInfo.car_id, '- not active in ExternalApi');
          }
          return isValid && isActive;
        })
        .map((carInfo, index) => {
          const carIndex = carInfo.car_id - 1;
          const driver = drivers[carIndex];
          
          const entry = {
            position: index + 1,
            car: carInfo.car_id, // Use real car_id from API
            driver: driver.name || `Voiture ${carInfo.car_id}`,
            laps: 0,
            lastLap: '--:--:---',
            bestLap: '--:--:---',
            gap: index === 0 ? '-' : '--',
            color: driver.color || this.getCarColor(carIndex),
            fuel: 15,
            pit: false,
            finished: false,
            pits: 0,
            refuel: false,
            time: 0,
            throttle: carInfo.accelerator_percent || 0,
            buttonPressed: carInfo.button_pressed || false,
            hasPaid: carInfo.has_coin || false,
            blocked: carInfo.blocked || false,
            manuallyUnblocked: carInfo.manually_unblocked || false,
            manuallyBlocked: carInfo.manually_blocked || false
          };
          this.logger.info(`📍 Active car ${carInfo.car_id}:`, entry.driver, 'Color:', entry.color);
          return entry;
        });

      this.logger.info('🏁 Updating race data...');
      this.updateRaceData({
        mode: 'practice',
        status: 'En attente',
        time: 0,
        currentLap: 0,
        laps: 0
      });

      this.logger.info('📊 Updating leaderboard with', leaderboard.length, 'entries (filtered by ExternalApi)...');
      this.updateLeaderboard(leaderboard);

      this.logger.info('⚡ Updating realtime data...');
      this.updateRealtime({
        bestLap: 0,
        totalLaps: 0,
        activeCars: leaderboard.length // Use filtered count
      });

      this.logger.info('✅ Web Display updated successfully with', leaderboard.length, 'active cars from ExternalApi');
    });
  }

  private setupWebSocketAlternative(): void {
    this.startWebSocketServer();
  }

  private throttledBroadcast(): void {
    if (this.broadcastThrottleTimer) {
      this.pendingBroadcast = true;
      return;
    }

    this.broadcast();
    this.broadcastThrottleTimer = setTimeout(() => {
      this.broadcastThrottleTimer = null;
      if (this.pendingBroadcast) {
        this.pendingBroadcast = false;
        this.throttledBroadcast();
      }
    }, 100); // Throttle to max 10 broadcasts per second
  }

  private broadcast(): void {
    const data = this.dataSubject.value;
    this.broadcastToWebSocketClients(data);
  }


  getServerUrl(): string | null {
    if (!this.isServerRunning) {
      return null;
    }
    
    // Préférer le nom mDNS si disponible
    return `http://${this.localHostname}:${this.port}`;
  }

  getServerIP(): string | null {
    if (!this.isServerRunning || !this.localIPAddress) {
      return null;
    }
    
    // Utiliser l'adresse IP réelle du device
    return `http://${this.localIPAddress}:${this.port}`;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  isRunning(): boolean {
    return this.isServerRunning;
  }

  getConnectedClientsCount(): number {
    return this.connectedClients.size;
  }

  getLocalIP(): string | null {
    return this.localIPAddress;
  }

  getWebSocketServerStatus(): boolean {
    return this.platform.is('cordova') && !!(window as any).cordova?.plugins?.wsserver;
  }

  getWebSocketUrl(): string | null {
    if (!this.isServerRunning || !this.localIPAddress) {
      return null;
    }
    return `ws://${this.localIPAddress}:${this.wsPort}`;
  }

  getWebSocketPort(): number {
    return this.wsPort;
  }

  // Force la mise à jour des pilotes (utile pour debug)
  forceDriversUpdate(): void {
    if (!this.isServerRunning) {
      this.logger.warn('⚠️ Cannot force drivers update - server not running');
      return;
    }
    
    this.logger.info('🔄 Forcing drivers update...');
    this.settings.getDrivers().pipe(take(1)).subscribe((drivers: any[]) => {
      this.logger.info('📋 Force update - found drivers:', drivers.length);
      this.logger.info('📋 Driver details:', drivers.map((d, i) => ({ index: i, name: d.name, color: d.color })));
      if (drivers.length > 0) {
        if (this.currentSession) {
          this.logger.info('🏁 Session is active - cannot force driver-only update');
        } else {
          this.updateWithDriversOnly(drivers);
        }
      } else {
        this.logger.warn('⚠️ No drivers found for force update');
      }
    });
  }

  private async publishMDNSService(): Promise<void> {
    try {
      if (this.platform.is('cordova') && (window as any).cordova?.plugins?.zeroconf) {
        const zeroconf = (window as any).cordova.plugins.zeroconf;
        
        const service = {
          type: this.mdnsServiceType,
          domain: 'local.',
          name: this.mdnsServiceName,
          port: this.port,
          txtRecord: {
            'path': '/',
            'description': 'OpenLap Race Display Server',
            'version': '1.0'
          }
        };

        await new Promise<void>((resolve, reject) => {
          zeroconf.register(service,
            (result: any) => {
              this.logger.info('mDNS service published successfully:', result);
              this.logger.info(`Service accessible at: http://${this.localHostname}:${this.port}`);
              resolve();
            },
            (error: any) => {
              this.logger.error('Failed to publish mDNS service:', error);
              reject(error);
            }
          );
        });
      } else {
        this.logger.warn('cordova-plugin-zeroconf not available');
        this.logger.info('To enable mDNS support, install: cordova plugin add cordova-plugin-zeroconf');
        this.logger.info('Service will be available via IP address only');
      }
    } catch (error) {
      this.logger.error('Error publishing mDNS service:', error);
    }
  }

  private async unpublishMDNSService(): Promise<void> {
    try {
      if (this.platform.is('cordova') && (window as any).cordova?.plugins?.zeroconf) {
        const zeroconf = (window as any).cordova.plugins.zeroconf;
        
        const service = {
          type: this.mdnsServiceType,
          domain: 'local.',
          name: this.mdnsServiceName
        };

        await new Promise<void>((resolve) => {
          zeroconf.unregister(service,
            (result: any) => {
              this.logger.info('mDNS service unpublished:', result);
              resolve();
            },
            (error: any) => {
              this.logger.warn('Failed to unpublish mDNS service:', error);
              resolve(); // Continue even if unpublish fails
            }
          );
        });
      }
    } catch (error) {
      this.logger.warn('Error unpublishing mDNS service:', error);
    }
  }

  private async getLocalIPAddress(): Promise<string> {
    try {
      if (this.platform.is('cordova')) {
        // Essayer plusieurs méthodes pour obtenir l'IP locale
        
        // Méthode 1: Plugin NetworkInterface (si disponible)
        if ((window as any).cordova?.plugins?.networkInterface) {
          try {
            const networkInterface = (window as any).cordova.plugins.networkInterface;
            
            return await new Promise<string>((resolve, reject) => {
              networkInterface.getWiFiIPAddress(
                (ip: string) => {
                  this.logger.info('WiFi IP from NetworkInterface plugin:', ip);
                  resolve(ip);
                },
                (error: any) => {
                  this.logger.warn('NetworkInterface plugin failed:', error);
                  reject(error);
                }
              );
            });
          } catch (error) {
            this.logger.warn('NetworkInterface plugin not working:', error);
          }
        }

        // Méthode 2: Plugin Network Information (si disponible)
        if ((window as any).Connection && (navigator as any).connection) {
          this.logger.info('Network connection type:', (navigator as any).connection.type);
        }

        // Méthode 3: Utiliser les APIs natives Cordova pour obtenir l'IP
        if ((window as any).networkinterface) {
          try {
            const interfaces = await (window as any).networkinterface.getWiFiIPAddress();
            if (interfaces && interfaces.length > 0) {
              const wifiIP = interfaces.find((iface: any) => 
                iface.ipAddress && !iface.ipAddress.startsWith('127.') && !iface.ipAddress.startsWith('169.254.')
              );
              if (wifiIP) {
                this.logger.info('WiFi IP from networkinterface:', wifiIP.ipAddress);
                return wifiIP.ipAddress;
              }
            }
          } catch (error) {
            this.logger.warn('networkinterface API failed:', error);
          }
        }

        // Méthode 4: WebRTC pour obtenir l'IP locale (fonctionne dans certains cas)
        try {
          const ip = await this.getIPViaWebRTC();
          if (ip && !ip.startsWith('127.') && !ip.startsWith('169.254.')) {
            this.logger.info('Local IP from WebRTC:', ip);
            return ip;
          }
        } catch (error) {
          this.logger.warn('WebRTC IP detection failed:', error);
        }
      }

      // Fallback: essayer de deviner l'IP basée sur des ranges communs
      this.logger.warn('Could not detect local IP, using common WiFi range');
      return '192.168.1.100'; // Fallback très basique
      
    } catch (error) {
      this.logger.error('Error getting local IP address:', error);
      return '192.168.1.100';
    }
  }

  private async getIPViaWebRTC(): Promise<string> {
    return new Promise((resolve, reject) => {
      const rtc = new RTCPeerConnection({
        iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
      });

      rtc.createDataChannel('');
      
      rtc.onicecandidate = (event) => {
        if (event.candidate) {
          const candidate = event.candidate.candidate;
          const ipMatch = candidate.match(/candidate:\d+ \d+ \w+ \d+ ([\d.]+)/);
          if (ipMatch && ipMatch[1]) {
            const ip = ipMatch[1];
            if (!ip.startsWith('127.') && !ip.startsWith('169.254.')) {
              rtc.close();
              resolve(ip);
              return;
            }
          }
        }
      };

      rtc.createOffer()
        .then(offer => rtc.setLocalDescription(offer))
        .catch(reject);

      // Timeout après 5 secondes
      setTimeout(() => {
        rtc.close();
        reject(new Error('WebRTC IP detection timeout'));
      }, 5000);
    });
  }

  // ========== WEBSOCKET METHODS ==========

  private startWebSocketServer(): void {
    this.logger.info('🚀 Starting WebSocket server...');
    
    if (this.platform.is('cordova') && (window as any).cordova?.plugins?.wsserver) {
      const wsserver = (window as any).cordova.plugins.wsserver;
      this.wsServer = wsserver; // Store reference for cleanup
      
      this.connectedClients.clear();
      this.startWebSocketServerInternal(wsserver);
    } else {
      this.logger.warn('⚠️ WebSocket server plugin not available');
      this.logger.info('Available cordova plugins:', Object.keys((window as any).cordova?.plugins || {}));
      this.logger.info('Will use HTTP file-based communication only');
    }
  }

  private startWebSocketServerInternal(wsserver: any): void {
    wsserver.start(this.wsPort, {
          onFailure: (addr: string, port: number, reason: string) => {
            this.logger.error('❌ WebSocket server failed on port', port, ':', reason);
            
            // Clear error message for port conflicts
            if (reason.includes('port') || reason.includes('bind') || reason.includes('address') || reason.includes('EADDRINUSE')) {
              this.logger.error('🚫 Port', port, 'is already in use by another application');
              this.logger.error('💡 Solutions:');
              this.logger.error('   - Close other applications using port', port);
              this.logger.error('   - Restart the OpenLap app');
              this.logger.error('   - Reboot your device if the problem persists');
            } else {
              this.logger.error('❌ WebSocket server startup failed:', reason);
            }
            
            this.logger.error('⚠️ Web Display will not receive real-time updates');
            this.logger.error('📱 External displays may not work correctly');
          },
          onOpen: (conn: any) => {
            this.logger.info('✅ WebSocket client connected:', conn.remoteAddr);
            this.connectedClients.add(conn);
            
            const currentData = this.dataSubject.value;
            const message = {
              type: 'race_data',
              data: currentData,
              timestamp: Date.now()
            };
            this.sendToClient(conn, message);
          },
          onMessage: (conn: any, msg: string) => {
            if (msg === 'ping') {
              this.sendToClient(conn, { type: 'pong' });
            }
          },
          onClose: (conn: any, code: number, reason: string, wasClean: boolean) => {
            this.logger.info('🔌 WebSocket client disconnected:', conn.remoteAddr);
            this.connectedClients.delete(conn);
          }
        }, (addr: string, port: number) => {
          this.logger.info('✅ WebSocket server started on', `${addr}:${port}`);
          this.wsPort = port;
        });
  }

  private stopWebSocketServer(): void {
    if (this.wsServer && (window as any).cordova?.plugins?.wsserver) {
      const wsserver = (window as any).cordova.plugins.wsserver;
      
      try {
        wsserver.stop(
          (addr: string, port: number) => {
            this.logger.info('🛑 WebSocket server stopped successfully');
            this.connectedClients.clear();
            this.wsServer = null;
          },
          (error: any) => {
            this.logger.warn('⚠️ Error stopping WebSocket server:', error);
            // Clean up anyway
            this.connectedClients.clear();
            this.wsServer = null;
          }
        );
      } catch (error) {
        this.logger.error('❌ Exception stopping WebSocket server:', error);
        this.connectedClients.clear();
        this.wsServer = null;
      }
    }
  }

  private broadcastToWebSocketClients(data: WebDisplayData): void {
    if (this.connectedClients.size === 0) {
      return;
    }

    const message = {
      type: 'race_data',
      data: data,
      timestamp: Date.now()
    };

    this.connectedClients.forEach(client => {
      this.sendToClient(client, message);
    });
  }

  private sendToClient(client: any, data: any): void {
    this.logger.info('📤 === WEBSOCKET SEND TO CLIENT DEBUG ===');
    this.logger.info('📤 Attempting to send data to client:', client.remoteAddr);
    
    try {
      if ((window as any).cordova?.plugins?.wsserver) {
        const wsserver = (window as any).cordova.plugins.wsserver;
        const jsonData = JSON.stringify(data);
        this.logger.info('📤 Data prepared for sending:', {
          type: data.type,
          dataSize: jsonData.length,
          clientAddr: client.remoteAddr,
          hasData: !!data.data,
          timestamp: data.timestamp
        });
        
        this.logger.info('📡 Calling wsserver.send()...');
        wsserver.send(client, jsonData);
        this.logger.info('✅ wsserver.send() completed successfully');
      } else {
        this.logger.error('❌ wsserver plugin not available for sending');
      }
    } catch (error) {
      this.logger.error('❌ === WEBSOCKET SEND ERROR ===');
      this.logger.error('❌ Error sending data to WebSocket client:', error);
      this.logger.error('❌ Client that failed:', client.remoteAddr);
      this.logger.error('❌ Removing failed client from connected list');
      this.connectedClients.delete(client);
      this.logger.info('📊 Clients after error cleanup:', this.connectedClients.size);
    }
  }

  // S'assurer qu'une connexion de données existe (priorité : Session > ControlUnit direct)
  private ensureDataConnection(): void {
    // Si une session est déjà connectée, ne rien faire
    if (this.currentSession) {
      this.logger.info('✅ Session already connected, data connection ensured');
      return;
    }
    
    this.logger.info('🔗 No session connected, attempting direct ControlUnit connection...');
    this.connectToLiveData();
  }

  // Se connecter directement aux données du ControlUnit (méthode de fallback uniquement)
  private connectToLiveData(): void {
    this.logger.info('🔗 FALLBACK MODE: Connecting to live ControlUnit data...');
    this.logger.warn('⚠️ Using fallback mode - no Session connected!');
    
    // Ne pas se connecter si une session est déjà active
    if (this.currentSession) {
      this.logger.info('⚠️ Session already connected, skipping direct ControlUnit connection');
      return;
    }
    
    // Déconnecter les abonnements précédents
    if (this.sessionSubscription) {
      this.sessionSubscription.unsubscribe();
      this.sessionSubscription = undefined;
    }
    
    // Se connecter aux observables du ControlUnitService ET ExternalApiService
    const drivers$ = this.settings.getDrivers();
    const controlUnit$ = this.controlUnitService.asObservable();
    
    this.sessionSubscription = combineLatest([
      controlUnit$,
      drivers$,
      this.externalApi.cars$,
      this.externalApi.coinAcceptors$
    ]).subscribe(([cu, drivers, apiCars, coinAcceptors]) => {
      this.logger.info('🔄 FALLBACK Live data update:', {
        hasControlUnit: !!cu,
        controlUnitType: cu?.constructor?.name,
        driversCount: drivers?.length || 0,
        drivers: drivers?.map((d, i) => `${i}: ${d.name || 'Unnamed'}`),
        controlUnitStatus: cu?.toString(),
        apiCarsCount: apiCars?.length || 0,
        coinAcceptorsCount: coinAcceptors?.length || 0
      });
      
      if (cu && drivers && drivers.length > 0) {
        this.logger.info('✅ FALLBACK: ControlUnit and drivers available - updating from ControlUnit');
        this.updateFromControlUnit(cu, drivers, apiCars, coinAcceptors);
      } else if (drivers && drivers.length > 0) {
        this.logger.info('⚠️ FALLBACK: No ControlUnit but drivers available - showing drivers only');
        this.updateWithDriversOnly(drivers);
      } else {
        this.logger.warn('❌ FALLBACK: No ControlUnit or drivers available:', {
          hasControlUnit: !!cu,
          driversCount: drivers?.length || 0,
          drivers: drivers
        });
        // Créer des données de test pour le debug
        this.createTestData();
      }
    });
  }

  // Mettre à jour l'affichage depuis les données directes du ControlUnit
  private updateFromControlUnit(cu: any, drivers: any[], apiCars?: any[], coinAcceptors?: any[]): void {
    this.logger.info('📊 Updating from ControlUnit data...');
    
    if (!cu) {
      this.logger.warn('❌ No ControlUnit available');
      this.updateWithDriversOnly(drivers);
      return;
    }

    // Récupérer les données en temps réel du ControlUnit
    const cuState$ = cu.getState();
    const cuStart$ = cu.getStart();
    const cuMode$ = cu.getMode();
    const cuTimer$ = cu.getTimer();
    const cuFuel$ = cu.getFuel();
    const cuPit$ = cu.getPit();

    // S'abonner aux données temps réel du ControlUnit - traiter chaque observable séparément
    const stateSubscription = cuState$.subscribe((state: any) => {
      this.logger.debug('🎛️ ControlUnit state update:', { state });
      this.updateRaceStatusFromControlUnit(state, drivers);
    });

    const dataSubscription = combineLatest([
      cuStart$,
      cuMode$,
      cuFuel$,
      cuPit$
    ]).subscribe(([start, mode, fuel, pit]: any[]) => {
      this.logger.debug('🎛️ ControlUnit data update:', { start, mode, fuel, pit });
      
      // Déterminer le statut de la course basé sur start
      let raceStatus = 'En attente';
      if (start === 0) {
        raceStatus = 'En cours';
      } else if (start && start > 0) {
        raceStatus = 'Feux de départ';
      }

      // Déterminer le mode de course basé sur le mode du ControlUnit
      let raceMode = 'practice';
      if (mode && (mode & 0x01)) raceMode = 'qualifying';
      if (mode && (mode & 0x02)) raceMode = 'race';

      // Créer le leaderboard SEULEMENT pour les voitures ACTIVES dans l'ExternalApi (même logique que connectSession)
      const leaderboard = [];
      
      // Si on a des données ExternalApi, filtrer selon les voitures actives
      if (apiCars && apiCars.length > 0) {
        this.logger.info('🎯 FALLBACK: Filtering by ExternalApi active cars:', apiCars.length);
        apiCars.forEach(carInfo => {
          const carIndex = carInfo.car_id - 1; // Convert 1-based to 0-based
          const isValid = carIndex >= 0 && carIndex < drivers.length;
          const isActive = carInfo.active === true;
          
          if (isValid && isActive) {
            const driver = drivers[carIndex];
            const driverFuel = (fuel && fuel[carIndex]) || 15;
            const isInPit = pit ? (pit & (1 << carIndex)) !== 0 : false;
            const coinInfo = coinAcceptors ? coinAcceptors.find(coin => coin.id === carInfo.car_id) : null;
            const hasPaid = carInfo.has_coin || (coinInfo ? coinInfo.coin_count > 0 : false);
            
            leaderboard.push({
              position: leaderboard.length + 1,
              car: carInfo.car_id,
              driver: driver.name || `Voiture ${carInfo.car_id}`,
              laps: 0,
              lastLap: '--:--:---',
              bestLap: '--:--:---',
              gap: leaderboard.length === 0 ? '-' : '--',
              color: driver.color || this.getCarColor(carIndex),
              fuel: driverFuel,
              pit: isInPit,
              finished: false,
              pits: 0,
              refuel: false,
              time: 0,
              throttle: carInfo.accelerator_percent || 0,
              buttonPressed: carInfo.button_pressed || false,
              hasPaid: hasPaid,
              blocked: carInfo.blocked || false,
              manuallyUnblocked: carInfo.manually_unblocked || false,
              manuallyBlocked: carInfo.manually_blocked || false
            });
            this.logger.info('✅ FALLBACK: Added ACTIVE car', carInfo.car_id, 'driver:', driver.name);
          } else if (isValid && !isActive) {
            this.logger.info('🚫 FALLBACK: Skipping INACTIVE car', carInfo.car_id);
          }
        });
      } else {
        // Fallback: si pas d'ExternalApi, utiliser tous les drivers comme avant
        this.logger.info('⚠️ FALLBACK: No ExternalApi data, showing all drivers');
        drivers.forEach((driver, index) => {
          const driverFuel = (fuel && fuel[index]) || 15;
          const isInPit = pit ? (pit & (1 << index)) !== 0 : false;
          const hasPaid = true; // Default si pas d'API
          
            leaderboard.push({
              position: leaderboard.length + 1,
              car: index + 1,
              driver: driver.name || `Voiture ${index + 1}`,
              laps: 0,
              lastLap: '--:--:---',
              bestLap: '--:--:---',
              gap: leaderboard.length === 0 ? '-' : '--',
              color: driver.color || this.getCarColor(index),
              fuel: driverFuel,
              pit: isInPit,
              finished: false,
              pits: 0,
              refuel: false,
              time: 0,
              throttle: 0,
              buttonPressed: false,
              hasPaid: hasPaid,
              blocked: false,
              manuallyUnblocked: false,
              manuallyBlocked: false
            });
        });
      }

      // Mettre à jour les données de course
      this.updateRaceData({
        mode: raceMode,
        status: raceStatus,
        time: 0, // Le timer sera géré séparément
        currentLap: 0, // Sera mis à jour par les événements
        laps: 0 // Configuration à venir des sessions
      });

      this.updateLeaderboard(leaderboard);
      
      this.updateRealtime({
        bestLap: 0,
        totalLaps: 0,
        activeCars: drivers.length,
        cars: leaderboard.map((entry, index) => ({
          id: index,
          speed: 0, // Vitesse sera disponible via d'autres observables
          position: entry.position,
          sector: entry.pit ? 'PIT' : 'PISTE'
        }))
      });

      this.logger.debug('✅ Updated display with live ControlUnit data');
    });

    // S'abonner aux événements de timing pour les tours et temps
    const timerSubscription = cuTimer$.subscribe(([carId, time, sector]) => {
      this.logger.debug('⏱️ Timer event:', { carId, time, sector });
      
      // Mettre à jour les données temps réel pour cette voiture
      const currentData = this.dataSubject.value;
      const updatedLeaderboard = currentData.leaderboard.map(entry => {
        if (entry.car === carId + 1) {
          // Mettre à jour le temps du dernier tour si c'est un passage de ligne
          if (sector === 1) {
            entry.lastLap = this.formatLapTime(time);
            entry.laps += 1;
          }
        }
        return entry;
      });

      this.updateLeaderboard(updatedLeaderboard);
    });

    // Nettoyer l'abonnement précédent s'il existe
    if (this.sessionSubscription) {
      this.sessionSubscription.unsubscribe();
    }

    // Combiner les abonnements ControlUnit
    this.sessionSubscription = new Subscription();
    this.sessionSubscription.add(stateSubscription);
    this.sessionSubscription.add(dataSubscription);
    this.sessionSubscription.add(timerSubscription);
  }

  // Mettre à jour le statut de course basé sur l'état du ControlUnit
  private updateRaceStatusFromControlUnit(state: string, drivers: any[]): void {
    let raceStatus = 'En attente';
    if (state === 'connected') {
      raceStatus = 'Connecté';
    } else if (state === 'connecting') {
      raceStatus = 'Connexion...';
    } else {
      raceStatus = 'Déconnecté';
    }

    // Mettre à jour seulement le statut
    const currentData = this.dataSubject.value;
    this.updateRaceData({
      ...currentData.race,
      status: raceStatus
    });
  }

  // Créer des données de test pour le debug
  private createTestData(): void {
    this.logger.info('🧪 Creating test data for debugging...');
    
    const testLeaderboard = [
      {
        position: 1,
        car: 1,
        driver: 'Demo Driver 1',
        laps: 5,
        lastLap: '01:23.456',
        bestLap: '01:20.123',
        gap: '-',
        color: 'Rouge',
        fuel: 12,
        pit: false,
        finished: false,
        pits: 1,
        refuel: false,
        time: 83456,
        throttle: 85,
        buttonPressed: true,
        hasPaid: true,
        blocked: false,
        manuallyUnblocked: false,
        manuallyBlocked: false
      },
      {
        position: 2,
        car: 2,
        driver: 'Demo Driver 2',
        laps: 5,
        lastLap: '01:25.789',
        bestLap: '01:22.456',
        gap: '+2.333',
        color: 'Bleu',
        fuel: 8,
        pit: true,
        finished: false,
        pits: 0,
        refuel: true,
        time: 85789,
        throttle: 60,
        buttonPressed: false,
        hasPaid: false,
        blocked: true,
        manuallyUnblocked: false,
        manuallyBlocked: true
      }
    ];

    this.updateRaceData({
      mode: 'practice',
      status: 'Demo Mode',
      time: 0,
      currentLap: 5,
      laps: 0
    });

    this.updateLeaderboard(testLeaderboard);
    
    this.updateRealtime({
      bestLap: 80123,
      totalLaps: 10,
      activeCars: 2,
      cars: [
        { id: 0, speed: 85, position: 1, sector: 'PISTE' },
        { id: 1, speed: 82, position: 2, sector: 'PISTE' }
      ]
    });

    this.logger.info('✅ Test data created');
  }

  ngOnDestroy(): void {
    this.logger.info('🧹 WebDisplayService: Cleaning up resources...');
    
    // Stop servers
    this.stopServer();
    
    // Clean up subscriptions
    if (this.sessionSubscription) {
      this.sessionSubscription.unsubscribe();
      this.sessionSubscription = undefined;
    }
    
    // Clear throttle timer
    if (this.broadcastThrottleTimer) {
      clearTimeout(this.broadcastThrottleTimer);
      this.broadcastThrottleTimer = null;
    }
    
    // Clear clients
    this.connectedClients.clear();
    
    this.logger.info('✅ WebDisplayService: Cleanup completed');
  }
}