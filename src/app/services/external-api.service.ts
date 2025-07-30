import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, BehaviorSubject, timer, EMPTY } from 'rxjs';
import { catchError, switchMap, tap } from 'rxjs/operators';

import { LoggingService } from './logging.service';
import { ApiResponse, ApiCar, CoinAcceptor } from './api-models';

@Injectable({
  providedIn: 'root'
})
export class ExternalApiService {
  private readonly baseApiUrl = 'http://10.8.17.64/api'; // URL de base de l'API
  private readonly apiUrl = `${this.baseApiUrl}/cars`; // À configurer selon votre API
  private readonly pollingInterval = 250; // 1 seconde
  
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
    private logger: LoggingService
  ) {}

  startPolling(): void {
    if (this.isPollingSubject.value) {
      return;
    }

    this.isPollingSubject.next(true);
    this.logger.info('Starting API polling');

    timer(0, this.pollingInterval).pipe(
      switchMap(() => this.isPollingSubject.value ? this.fetchData() : EMPTY),
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
    return this.http.get<ApiResponse>(this.apiUrl).pipe(
      tap(response => {
        this.carsSubject.next(response.cars);
        this.coinAcceptorsSubject.next(response.coin_acceptors);
        this.timestampSubject.next(response.timestamp);
      }),
      catchError(error => {
        this.logger.error('Failed to fetch API data:', error);
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
    const url = `${this.baseApiUrl}/consume-coin`;
    const body = { coin_acceptor_id: coinAcceptorId };
    
    return this.http.post<any>(url, body).pipe(
      tap(response => {
        this.logger.info(`Coin consumed for acceptor ${coinAcceptorId}:`, response);
      }),
      catchError(error => {
        this.logger.error(`Failed to consume coin for acceptor ${coinAcceptorId}:`, error);
        throw error;
      })
    );
  }

  /**
   * Bloque ou débloque une voiture
   */
  blockCar(carId: number, blocked: boolean): Observable<any> {
    const url = `${this.baseApiUrl}/block-car`;
    const body = { car_id: carId, blocked };
    
    return this.http.post<any>(url, body).pipe(
      tap(response => {
        this.logger.info(`Car ${carId} ${blocked ? 'blocked' : 'unblocked'}:`, response);
      }),
      catchError(error => {
        this.logger.error(`Failed to ${blocked ? 'block' : 'unblock'} car ${carId}:`, error);
        throw error;
      })
    );
  }

  /**
   * Remet une voiture à l'état normal (efface les contrôles manuels)
   */
  resetCarToNormal(carId: number): Observable<any> {
    const url = `${this.baseApiUrl}/block-car`;
    const body = { car_id: carId, reset_to_normal: true };
    
    return this.http.post<any>(url, body).pipe(
      tap(response => {
        this.logger.info(`Car ${carId} reset to normal state:`, response);
      }),
      catchError(error => {
        this.logger.error(`Failed to reset car ${carId} to normal:`, error);
        throw error;
      })
    );
  }
}