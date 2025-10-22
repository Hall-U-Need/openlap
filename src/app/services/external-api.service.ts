import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, BehaviorSubject, EMPTY, defer } from 'rxjs';
import { catchError, map, tap, timeout, delay, repeat } from 'rxjs/operators';

import { LoggingService } from './logging.service';
import { ApiResponse, ApiCar, CoinAcceptor } from './api-models';
import { AppSettings } from '../app-settings';

@Injectable({
  providedIn: 'root'
})
export class ExternalApiService {
  private baseApiUrl = 'http://10.8.17.64/api';
  private apiUrl = `${this.baseApiUrl}/cars`;
  private httpTimeout = 1000; // Timeout de 1 seconde pour les requêtes HTTP
  private enabled = false;
  private pollingSubscription?: any;
  
  private carsSubject = new BehaviorSubject<ApiCar[]>([]);
  private coinAcceptorsSubject = new BehaviorSubject<CoinAcceptor[]>([]);
  private timestampSubject = new BehaviorSubject<number>(0);
  private isPollingSubject = new BehaviorSubject<boolean>(false);
  private isConnectedSubject = new BehaviorSubject<boolean>(false);

  // Mémoriser l'état initial des coin_value à la première connexion
  private initialCoinValues = new Map<number, number>(); // car_id -> coin_value initial
  private isInitialized = false;

  public cars$ = this.carsSubject.asObservable();
  public coinAcceptors$ = this.coinAcceptorsSubject.asObservable();
  public timestamp$ = this.timestampSubject.asObservable();
  public isPolling$ = this.isPollingSubject.asObservable();
  public isConnected$ = this.isConnectedSubject.asObservable();

  constructor(
    private http: HttpClient,
    private logger: LoggingService,
    private settings: AppSettings
  ) {
    // Écouter les changements de configuration
    this.settings.getExternalApi().subscribe(config => {
      const wasEnabled = this.enabled;
      this.enabled = config.enabled;
      this.baseApiUrl = config.apiUrl;
      this.apiUrl = `${this.baseApiUrl}/cars`;

      this.logger.info('External API configuration updated:', {
        enabled: this.enabled,
        apiUrl: this.baseApiUrl
      });

      // Redémarrer le polling si la configuration a changé et que l'API est activée
      if (this.enabled && wasEnabled && this.isPollingSubject.value) {
        this.stopPolling();
        this.startPolling();
      }
    });
  }

  startPolling(): void {
    if (this.isPollingSubject.value || !this.enabled) {
      if (!this.enabled) {
        this.logger.info('External API is disabled, not starting polling');
      }
      return;
    }

    // Réinitialiser l'état à chaque démarrage de polling
    this.isInitialized = false;
    this.initialCoinValues.clear();

    this.isPollingSubject.next(true);
    this.logger.info('Starting continuous API polling (100ms delay between requests)', { url: this.apiUrl });

    // Polling continu avec délai de 100ms entre chaque requête
    const poll = () => {
      if (!this.isPollingSubject.value || !this.enabled) {
        return;
      }

      this.fetchData().subscribe({
        complete: () => {
          // Petit délai de 100ms avant de relancer pour éviter de saturer
          setTimeout(() => poll(), 100);
        }
      });
    };

    poll(); // Démarrer le polling
  }

  stopPolling(): void {
    this.isPollingSubject.next(false);
    this.isConnectedSubject.next(false);
    this.logger.info('Stopping API polling');
  }

  private fetchData(): Observable<ApiResponse> {
    if (!this.enabled) {
      return EMPTY;
    }

    return this.http.get<ApiResponse>(this.apiUrl).pipe(
      timeout({ first: this.httpTimeout }),
      tap(response => {
        // À la première connexion, mémoriser les valeurs initiales
        if (!this.isInitialized) {
          this.isInitialized = true;
          response.cars.forEach(car => {
            this.initialCoinValues.set(car.car_id, car.coin_value || 0);
          });
          this.logger.info('Initial coin values captured:', Array.from(this.initialCoinValues.entries()));
        }

        // Forcer une nouvelle référence pour que combineLatest se redéclenche
        this.carsSubject.next([...response.cars]);
        this.coinAcceptorsSubject.next([...response.coin_acceptors]);
        this.timestampSubject.next(response.timestamp);

        // Marquer comme connecté en cas de succès
        const wasDisconnected = !this.isConnectedSubject.value;
        this.isConnectedSubject.next(true);
        if (wasDisconnected) {
          this.logger.info('✅ External API connected');
        }
      }),
      catchError(error => {
        // Marquer comme déconnecté en cas d'erreur
        const wasConnected = this.isConnectedSubject.value;
        this.isConnectedSubject.next(false);

        if (wasConnected) {
          this.logger.error('❌ External API connection lost');
          this.logger.error('Failed to fetch API data from:', this.apiUrl);

          // Log du type d'erreur
          if (error.name === 'TimeoutError') {
            this.logger.error('Error: Request timeout after', this.httpTimeout, 'ms');
          } else {
            this.logger.error('Error details:', {
              status: error.status,
              statusText: error.statusText,
              message: error.message,
              url: error.url,
              name: error.name
            });

            // Diagnostics supplémentaires
            if (error.status === 0) {
              this.logger.error('Network error - possible causes:');
              this.logger.error('1. API server not running at', this.baseApiUrl);
              this.logger.error('2. Network connectivity issues');
              this.logger.error('3. CORS policy blocking the request');
              this.logger.error('4. Firewall blocking the connection');
            } else if (error.status === 404) {
              this.logger.error('API endpoint not found. Check if', this.apiUrl, 'is correct');
            } else if (error.status >= 500) {
              this.logger.error('Server error at', this.baseApiUrl);
            }
          }
        }

        // Retourner EMPTY pour continuer le polling sans erreur
        return EMPTY;
      })
    );
  }

  getCarById(carId: number): ApiCar | undefined {
    return this.carsSubject.value.find(car => car.car_id === carId);
  }

  getCoinAcceptorById(id: number): CoinAcceptor | undefined {
    return this.coinAcceptorsSubject.value.find(acceptor => acceptor.id === id);
  }

  setApiUrl(url: string): void {
    // Méthode pour configurer l'URL de l'API dynamiquement
    (this as any).apiUrl = url;
  }

  setPollingInterval(intervalMs: number): void {
    // Méthode obsolète - le polling est maintenant continu sans intervalle
    this.logger.warn('setPollingInterval is deprecated - polling is now continuous');
  }

  getActiveCars(): ApiCar[] {
    return this.carsSubject.value.filter(car => car.active);
  }

  /**
   * Obtenir la valeur initiale de coin_value pour une voiture
   */
  getInitialCoinValue(carId: number): number {
    return this.initialCoinValues.get(carId) || 0;
  }

  /**
   * Calculer la différence entre la valeur actuelle et initiale de coin_value
   * (montant ajouté pendant la session)
   */
  getCoinValueDelta(carId: number): number {
    const car = this.getCarById(carId);
    const currentValue = car?.coin_value || 0;
    const initialValue = this.getInitialCoinValue(carId);
    return currentValue - initialValue;
  }

  /**
   * Marque les pièces comme consommées en synchronisant les valeurs initiales avec les valeurs actuelles
   * Cela permet de "consommer" les pièces pour les voitures qui ont participé à la course
   */
  markCoinsAsConsumed(carIds: number[]): void {
    carIds.forEach(carId => {
      const car = this.getCarById(carId);
      if (car) {
        const currentValue = car.coin_value || 0;
        this.initialCoinValues.set(carId, currentValue);
        this.logger.info(`Coins marked as consumed for car ${carId}. New initial value:`, currentValue);
      }
    });
  }

  /**
   * Consomme une pièce d'un monnayeur spécifique (OBSOLETE - utiliser markCoinsAsConsumed)
   */
  consumeCoin(coinAcceptorId: number): Observable<any> {
    if (!this.enabled) {
      this.logger.warn('External API is disabled, cannot consume coin');
      return EMPTY;
    }

    const url = `${this.baseApiUrl}/consume-coin`;
    const body = { coin_acceptor_id: coinAcceptorId };

    return this.http.post<any>(url, body).pipe(
      tap(response => {
        this.logger.info(`Coin consumed for acceptor ${coinAcceptorId}:`, response);
      }),
      catchError(error => {
        this.logger.error(`Failed to consume coin for acceptor ${coinAcceptorId} at ${url}:`, error);
        throw error;
      })
    );
  }

  /**
   * Bloque ou débloque une voiture
   */
  blockCar(carId: number, blocked: boolean): Observable<any> {
    if (!this.enabled) {
      this.logger.warn('External API is disabled, cannot block/unblock car');
      return EMPTY;
    }
    
    const url = `${this.baseApiUrl}/block-car`;
    const body = { car_id: carId, blocked };
    
    return this.http.post<any>(url, body).pipe(
      tap(response => {
        this.logger.info(`Car ${carId} ${blocked ? 'blocked' : 'unblocked'}:`, response);
      }),
      catchError(error => {
        this.logger.error(`Failed to ${blocked ? 'block' : 'unblock'} car ${carId} at ${url}:`, error);
        throw error;
      })
    );
  }

  /**
   * Remet une voiture à l'état normal (efface les contrôles manuels)
   */
  resetCarToNormal(carId: number): Observable<any> {
    if (!this.enabled) {
      this.logger.warn('External API is disabled, cannot reset car to normal');
      return EMPTY;
    }
    
    const url = `${this.baseApiUrl}/block-car`;
    const body = { car_id: carId, reset_to_normal: true };
    
    return this.http.post<any>(url, body).pipe(
      tap(response => {
        this.logger.info(`Car ${carId} reset to normal state:`, response);
      }),
      catchError(error => {
        this.logger.error(`Failed to reset car ${carId} to normal at ${url}:`, error);
        throw error;
      })
    );
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Test la connexion à l'API externe
   */
  testConnection(): Observable<boolean> {
    if (!this.enabled) {
      this.logger.warn('External API is disabled, cannot test connection');
      return EMPTY;
    }

    this.logger.info('Testing connection to External API at:', this.baseApiUrl);
    
    return this.http.get<ApiResponse>(this.apiUrl).pipe(
      tap(response => {
        this.logger.info('✅ External API connection test successful');
        this.logger.info('Response:', {
          carsCount: response.cars?.length || 0,
          coinAcceptorsCount: response.coin_acceptors?.length || 0,
          timestamp: response.timestamp
        });
      }),
      map(() => true),
      catchError(error => {
        this.logger.error('❌ External API connection test failed');
        this.logger.error('Error details:', {
          status: error.status,
          statusText: error.statusText,
          message: error.message,
          url: error.url
        });
        return [false];
      })
    );
  }
}