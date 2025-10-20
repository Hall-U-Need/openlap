import { Injectable, OnDestroy } from '@angular/core';
import { Platform } from '@ionic/angular';
import { BehaviorSubject, Observable, Subscription, combineLatest } from 'rxjs';
import { distinctUntilChanged, map } from 'rxjs/operators';
// Simplified imports for new RMS-based approach

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
    startLights?: number;  // 0-5: nombre de feux allumés
    startBlink?: boolean;  // true si les feux clignotent
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
    brakeWear: number;
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
  private timerSubscription?: Subscription;
  private startLightsSubscription?: Subscription;
  private lapCountSubscription?: Subscription;
  private currentSession?: Session;
  private currentOptions?: any;
  private currentTime = 0;
  private currentLap = 0;
  private currentRaceStatus = 'En cours';
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
      
      // Config changed - new approach will be connected from RMS page
    });

    // Drivers changes will be handled by new RMS-based approach

    // ControlUnit changes will be handled by new RMS-based approach
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
          
          // Connection will be managed by RMS page when session starts
          this.logger.info('🔧 Web Display server ready - waiting for RMS connection...');
          
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

  // NOUVELLE APPROCHE : Connecter directement aux données finales de RMS
  connectToRmsData(rmsComponent: any, options?: any): void {
    this.logger.info('🎯 NEW APPROACH: Connecting to RMS data (safe version)', {
      mode: options?.mode,
      hasComponent: !!rmsComponent,
      hasItems: !!rmsComponent?.items,
      hasSession: !!rmsComponent?.session,
      hasCu: !!rmsComponent?.cu,
      sessionId: Math.random().toString(36).substr(2, 9) // Pour tracking
    });

    // Vérifications de sécurité
    if (!rmsComponent || !rmsComponent.items) {
      this.logger.error('❌ RMS component or items not available:', {
        hasComponent: !!rmsComponent,
        hasItems: !!rmsComponent?.items
      });
      return;
    }

    // Déconnecter la session précédente
    this.disconnectSession();

    // Stocker les options pour les utiliser dans les updates
    this.currentOptions = options;

    // Stocker la session pour accéder au timer
    if (rmsComponent.session) {
      this.currentSession = rmsComponent.session;
    }

    try {
      // S'abonner au timer de la session pour le temps de course
      if (rmsComponent.session?.timer) {
        this.timerSubscription = rmsComponent.session.timer.subscribe(
          (time: number) => {
            this.currentTime = time;
            // Mettre à jour uniquement le temps sans recalculer tout
            this.updateRaceData({
              mode: options?.mode || 'practice',
              status: this.currentRaceStatus || 'En cours',
              time: time,
              currentLap: this.currentLap,
              laps: options?.laps || 0
            });
          }
        );
        this.logger.info('✅ Subscribed to session timer');
      }

      // S'abonner au nombre de tours actuel
      if (rmsComponent.session?.currentLap) {
        this.lapCountSubscription = rmsComponent.session.currentLap.subscribe(
          (lap: number) => {
            this.currentLap = lap;
            this.logger.info('📊 Current lap updated:', lap);
            // Mettre à jour les données de course avec le nouveau lap
            this.updateRaceData({
              mode: options?.mode || 'practice',
              status: this.currentRaceStatus || 'En cours',
              time: this.currentTime,
              currentLap: lap,
              laps: options?.laps || 0
            });
          }
        );
        this.logger.info('✅ Subscribed to current lap counter');
      }

      // S'abonner aux feux de départ du ControlUnit
      if (rmsComponent.cu?.value) {
        const cu = rmsComponent.cu.value;

        const start$ = cu.getStart().pipe(distinctUntilChanged()) as Observable<number>;
        const state$ = cu.getState() as Observable<'disconnected' | 'connecting' | 'connected'>;

        this.startLightsSubscription = combineLatest({
          startValue: start$,
          cuState: state$
        }).pipe(
          map(({ startValue, cuState }) => {
            // Même logique que dans race-control.component.ts
            const lights = startValue == 1 ? 5 : startValue > 1 && startValue < 7 ? startValue - 1 : 0;
            const blink = startValue >= 8 || cuState !== 'connected';
            return { lights, blink };
          })
        ).subscribe(
          ({ lights, blink }) => {
            this.updateRaceData({
              mode: options?.mode || 'practice',
              status: this.currentRaceStatus || 'En cours',
              time: this.currentTime,
              currentLap: this.currentLap,
              laps: options?.laps || 0,
              startLights: lights,
              startBlink: blink
            });
          }
        );
        this.logger.info('✅ Subscribed to start lights');
      }

      // S'abonner directement aux items finaux de RMS (données parfaites !)
      let dataCount = 0;
      this.sessionSubscription = rmsComponent.items.subscribe(
        (items: any[]) => {
          dataCount++;
          if (items && Array.isArray(items)) {
            this.logger.info(`📊 [${dataCount}] Received PERFECT RMS data:`, {
              itemsCount: items.length,
              mode: options?.mode,
              firstItemThrottle: items[0]?.throttle,
              timestamp: Date.now()
            });
            this.updateFromRmsItems(items, options);
          } else {
            this.logger.warn(`⚠️ [${dataCount}] Received invalid RMS data:`, items);
          }
        },
        (error: any) => {
          this.logger.error('❌ RMS items subscription error:', error);
        },
        () => {
          this.logger.warn('⚠️ RMS items subscription completed (stream ended)');
        }
      );

      this.logger.info('✅ Successfully subscribed to RMS items with error/complete handlers');
    } catch (error) {
      this.logger.error('❌ Failed to subscribe to RMS items:', error);
    }
  }

  // Transformer les données RMS parfaites en format WebDisplay 
  private updateFromRmsItems(items: any[], options?: any): void {
    this.logger.info('🔄 Converting RMS items to WebDisplay format:', {
      itemsCount: items.length,
      mode: options?.mode || 'unknown',
      firstItem: items[0] ? {
        id: items[0].id,
        driver: items[0].driver?.name,
        throttle: items[0].throttle,
        buttonPressed: items[0].buttonPressed,
        hasPaid: items[0].hasPaid
      } : null
    });

    // 1. Race data
    const raceStatus = this.determineRaceStatus(items, options);
    this.currentRaceStatus = raceStatus;
    this.updateRaceData({
      mode: options?.mode || 'practice',
      status: raceStatus,
      time: this.currentTime, // Utiliser le temps du timer
      currentLap: this.currentLap, // Obtenu via subscription à session.currentLap
      laps: options?.laps || 0
    });

    // 2. Leaderboard (conversion directe des items RMS)
    const leaderboard = items.map((item, index) => ({
      position: index + 1,
      car: item.id + 1, // RMS uses 0-based, display uses 1-based
      driver: item.driver?.name || `Voiture ${item.id + 1}`,
      laps: item.laps || 0,
      lastLap: this.formatLapTime(item.last?.[0]) || '--:--:---',
      bestLap: this.formatLapTime(item.best?.[0]) || '--:--:---',
      gap: index === 0 ? '-' : '--', // TODO: Calculate gap if needed
      color: item.driver?.color || this.getCarColor(item.id),
      fuel: item.fuel || 15,
      pit: item.pit || false,
      finished: item.finished || false,
      pits: item.pits || 0,
      refuel: item.refuel || false,
      time: item.time || 0,
      // Données temps réel directement depuis RMS !
      throttle: item.throttle || 0,
      buttonPressed: item.buttonPressed || false,
      hasPaid: item.hasPaid !== undefined ? item.hasPaid : true,
      blocked: item.blocked || false,
      manuallyUnblocked: item.manuallyUnblocked || false,
      manuallyBlocked: item.manuallyBlocked || false,
      brakeWear: item.brakeWear !== undefined ? item.brakeWear : 15
    }));

    this.updateLeaderboard(leaderboard);

    // 3. Realtime data
    this.updateRealtime({
      bestLap: leaderboard.reduce((best, entry) => {
        const lapTime = this.parseLapTime(entry.bestLap);
        return lapTime > 0 && lapTime < best ? lapTime : best;
      }, Infinity),
      totalLaps: leaderboard.reduce((total, entry) => total + entry.laps, 0),
      activeCars: leaderboard.length,
      cars: leaderboard.map((entry, index) => ({
        id: index,
        speed: entry.throttle, // Use throttle as speed indicator
        position: entry.position,
        sector: entry.pit ? 'PIT' : 'PISTE'
      }))
    });

    this.logger.info('✅ WebDisplay updated with PERFECT RMS data');
  }

  private determineRaceStatus(items: any[], options?: any): string {
    // TODO: Determine race status based on items/options
    return 'En cours';
  }

  private parseLapTime(lapTimeString: string): number {
    if (!lapTimeString || lapTimeString === '--:--:---') return 0;
    // Convert MM:SS.sss to milliseconds
    const parts = lapTimeString.split(':');
    if (parts.length !== 2) return 0;
    const minutes = parseInt(parts[0]);
    const secParts = parts[1].split('.');
    const seconds = parseInt(secParts[0]);
    const ms = secParts[1] ? parseInt(secParts[1]) : 0;
    return (minutes * 60 + seconds) * 1000 + ms;
  }
  
  // ANCIENNE APPROCHE SUPPRIMÉE - Utilisez connectToRmsData() à la place

  // Déconnecter la session actuelle
  disconnectSession(): void {
    this.logger.info('🔌 Disconnecting session...', {
      hasSubscription: !!this.sessionSubscription,
      hasTimerSubscription: !!this.timerSubscription,
      hasStartLightsSubscription: !!this.startLightsSubscription,
      hasLapCountSubscription: !!this.lapCountSubscription,
      hasCurrentSession: !!this.currentSession
    });

    if (this.sessionSubscription) {
      try {
        this.sessionSubscription.unsubscribe();
        this.sessionSubscription = undefined;
        this.logger.info('✅ Successfully unsubscribed from previous session');
      } catch (error) {
        this.logger.error('❌ Error unsubscribing from session:', error);
        this.sessionSubscription = undefined; // Force cleanup
      }
    }

    if (this.timerSubscription) {
      try {
        this.timerSubscription.unsubscribe();
        this.timerSubscription = undefined;
        this.logger.info('✅ Successfully unsubscribed from timer');
      } catch (error) {
        this.logger.error('❌ Error unsubscribing from timer:', error);
        this.timerSubscription = undefined;
      }
    }

    if (this.lapCountSubscription) {
      try {
        this.lapCountSubscription.unsubscribe();
        this.lapCountSubscription = undefined;
        this.logger.info('✅ Successfully unsubscribed from lap counter');
      } catch (error) {
        this.logger.error('❌ Error unsubscribing from lap counter:', error);
        this.lapCountSubscription = undefined;
      }
    }

    if (this.startLightsSubscription) {
      try {
        this.startLightsSubscription.unsubscribe();
        this.startLightsSubscription = undefined;
        this.logger.info('✅ Successfully unsubscribed from start lights');
      } catch (error) {
        this.logger.error('❌ Error unsubscribing from start lights:', error);
        this.startLightsSubscription = undefined;
      }
    }

    this.currentSession = undefined;
    this.logger.info('🔌 Disconnected race session from Web Display');
  }

  hasActiveSession(): boolean {
    return !!this.sessionSubscription;
  }

  // OLD APPROACH REMOVED - Use connectToRmsData() for perfect data

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

  // OLD APPROACH REMOVED - Use connectToRmsData() for perfect data

  // OLD APPROACH REMOVED - Use connectToRmsData() for perfect data


  // OLD APPROACH REMOVED - Use connectToRmsData() for perfect data

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

  // OLD APPROACH REMOVED - Use connectToRmsData() for perfect data

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

  // OLD APPROACH REMOVED - Use connectToRmsData() for perfect data

  // OLD APPROACH REMOVED - Use connectToRmsData() for perfect data

  // OLD APPROACH REMOVED - Use connectToRmsData() for perfect data

  // OLD APPROACH REMOVED - Use connectToRmsData() for perfect data

  // OLD APPROACH REMOVED - Use connectToRmsData() for perfect data

  // OLD APPROACH REMOVED - Use connectToRmsData() for perfect data

  // OLD APPROACH REMOVED - Use connectToRmsData() for perfect data

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