import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, BehaviorSubject, timer, EMPTY } from 'rxjs';
import { catchError, map, switchMap, tap } from 'rxjs/operators';

import { LoggingService } from './logging.service';
import { ApiResponse, ApiCar, CoinAcceptor } from './api-models';
import { AppSettings } from '../app-settings';

@Injectable({
  providedIn: 'root'
})
export class ExternalApiService {
  private baseApiUrl = 'http://10.8.17.64/api';
  private apiUrl = `${this.baseApiUrl}/cars`;
  private pollingInterval = 250;
  private enabled = false;
  
  private carsSubject = new BehaviorSubject<ApiCar[]>([]);
  private coinAcceptorsSubject = new BehaviorSubject<CoinAcceptor[]>([]);
  private timestampSubject = new BehaviorSubject<number>(0);
  private isPollingSubject = new BehaviorSubject<boolean>(false);

  public cars$ = this.carsSubject.asObservable();
  public coinAcceptors$ = this.coinAcceptorsSubject.asObservable();
  public timestamp$ = this.timestampSubject.asObservable();
  public isPolling$ = this.isPollingSubject.asObservable();

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
      this.pollingInterval = config.pollingInterval;
      
      this.logger.info('External API configuration updated:', {
        enabled: this.enabled,
        apiUrl: this.baseApiUrl,
        pollingInterval: this.pollingInterval
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

    this.isPollingSubject.next(true);
    this.logger.info('Starting API polling', { url: this.apiUrl, interval: this.pollingInterval });

    timer(0, this.pollingInterval).pipe(
      switchMap(() => this.isPollingSubject.value && this.enabled ? this.fetchData() : EMPTY),
      catchError(error => {
        this.logger.error('API polling error:', error);
        return EMPTY;
      })
    ).subscribe();
  }

  stopPolling(): void {
    this.isPollingSubject.next(false);
    this.logger.info('Stopping API polling');
  }

  private fetchData(): Observable<ApiResponse> {
    if (!this.enabled) {
      return EMPTY;
    }
    
    return this.http.get<ApiResponse>(this.apiUrl).pipe(
      tap(response => {
        // Log removed to reduce noise - API polling every 250ms
        this.carsSubject.next(response.cars);
        this.coinAcceptorsSubject.next(response.coin_acceptors);
        this.timestampSubject.next(response.timestamp);
      }),
      catchError(error => {
        this.logger.error('Failed to fetch API data from:', this.apiUrl);
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
        
        throw error;
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
    // Méthode pour configurer l'intervalle de polling
    (this as any).pollingInterval = intervalMs;
  }

  getActiveCars(): ApiCar[] {
    return this.carsSubject.value.filter(car => car.active);
  }

  /**
   * Consomme une pièce d'un monnayeur spécifique
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