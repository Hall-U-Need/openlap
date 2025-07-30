import { Injectable } from '@angular/core';
import { combineLatest, Observable, forkJoin } from 'rxjs';
import { map, distinctUntilChanged, filter } from 'rxjs/operators';

import { ExternalApiService } from './external-api.service';
import { ApiCar } from './api-models';
import { AppSettings, Driver } from '../app-settings';
import { LoggingService } from './logging.service';

@Injectable({
  providedIn: 'root'
})
export class CarSyncService {
  
  constructor(
    private externalApi: ExternalApiService,
    private appSettings: AppSettings,
    private logger: LoggingService
  ) {}

  /**
   * Synchronise automatiquement les voitures détectées par l'API avec les drivers de l'application
   */
  startCarSync(): void {
    this.logger.info('Starting car synchronization with external API');

    // Combiner les données de l'API avec les drivers existants
    combineLatest([
      this.externalApi.cars$,
      this.appSettings.getDrivers()
    ]).pipe(
      filter(([cars, drivers]) => cars && cars.length > 0),
      map(([cars, drivers]) => this.syncCarsWithDrivers(cars, drivers)),
      distinctUntilChanged((prev, curr) => JSON.stringify(prev) === JSON.stringify(curr))
    ).subscribe(updatedDrivers => {
      this.appSettings.setDrivers(updatedDrivers).catch(error => {
        this.logger.error('Error updating drivers from API:', error);
      });
    });
  }

  private syncCarsWithDrivers(apiCars: ApiCar[], currentDrivers: Driver[]): Driver[] {
    const updatedDrivers = [...currentDrivers];
    
    apiCars.forEach(car => {
      const driverIndex = car.car_id - 1; // car_id is 1-based, array is 0-based
      
      if (driverIndex >= 0 && driverIndex < updatedDrivers.length) {
        const currentDriver = updatedDrivers[driverIndex];
        
        // Mettre à jour le nom si la voiture est active et n'a pas encore de nom personnalisé
        if (car.active && car.name && (!currentDriver.name || currentDriver.name.startsWith('Driver'))) {
          updatedDrivers[driverIndex] = {
            ...currentDriver,
            name: car.name,
            // Générer un code automatiquement basé sur le nom si pas déjà défini
            code: currentDriver.code || this.generateCode(car.name, driverIndex, updatedDrivers)
          };
          
          this.logger.info(`Updated driver ${driverIndex + 1}: ${car.name} (${car.active ? 'active' : 'inactive'})`);
        }
      }
    });
    
    return updatedDrivers;
  }

  private generateCode(name: string, driverIndex: number, allDrivers: Driver[]): string {
    if (!name) return '';
    
    // Nettoyer le nom et prendre les premières lettres
    const cleanName = name.replace(/\W/g, '').toUpperCase();
    if (cleanName.length === 0) return '';
    
    // Collecter tous les codes existants
    const existingCodes = allDrivers
      .filter((_, index) => index !== driverIndex)
      .map(driver => driver.code)
      .filter(code => code);
    
    // Essayer différentes combinaisons
    const combinations = [
      cleanName.substring(0, 3), // Les 3 premières lettres
      cleanName.substring(0, 2) + cleanName.substring(cleanName.length - 1), // 2 premières + dernière
      cleanName.substring(0, 2) + (driverIndex + 1), // 2 premières + numéro
    ];
    
    for (const combination of combinations) {
      if (combination.length >= 2 && !existingCodes.includes(combination)) {
        return combination;
      }
    }
    
    // Fallback: utiliser un numéro
    return `CAR${driverIndex + 1}`;
  }

  /**
   * Obtenir les informations temps réel d'une voiture depuis l'API
   */
  getCarRealTimeInfo(carId: number): ApiCar | undefined {
    return this.externalApi.getCarById(carId);
  }

  /**
   * Vérifier si une voiture est active selon l'API
   */
  isCarActive(carId: number): boolean {
    const car = this.externalApi.getCarById(carId);
    return car ? car.active : false;
  }

  /**
   * Obtenir le pourcentage d'accélération d'une voiture
   */
  getCarAcceleration(carId: number): number {
    const car = this.externalApi.getCarById(carId);
    return car ? car.accelerator_percent : 0;
  }

  /**
   * Obtenir toutes les voitures actives depuis l'API
   */
  getActiveCars(): ApiCar[] {
    return this.externalApi.getActiveCars();
  }

  /**
   * Vérifier si une voiture a payé (a inséré une pièce)
   */
  hasCarPaid(carId: number): boolean {
    const car = this.externalApi.getCarById(carId);
    if (car && car.has_coin !== undefined) {
      return car.has_coin;
    }
    // Fallback vers l'ancienne méthode si has_coin n'est pas disponible
    const coinAcceptor = this.externalApi.getCoinAcceptorById(carId);
    return coinAcceptor ? coinAcceptor.coin_count > 0 : false;
  }

  /**
   * Obtenir les informations du monnayeur pour une voiture
   */
  getCarCoinAcceptor(carId: number) {
    return this.externalApi.getCoinAcceptorById(carId);
  }

  /**
   * Vérifier si une voiture peut participer à la course (active ET payée ET pas bloquée manuellement)
   */
  canCarParticipate(carId: number): boolean {
    const car = this.externalApi.getCarById(carId);
    const isActive = this.isCarActive(carId);
    const hasPaid = this.hasCarPaid(carId);
    const isManuallyBlocked = car ? car.manually_blocked : false;
    
    // Une voiture peut participer si elle est active, a payé ET n'est pas bloquée manuellement
    return isActive && hasPaid && !isManuallyBlocked;
  }

  /**
   * Observable des voitures depuis l'API externe
   */
  get cars$(): Observable<ApiCar[]> {
    return this.externalApi.cars$;
  }

  /**
   * Consomme les pièces pour toutes les voitures participantes au démarrage de la course
   */
  consumeCoinsForParticipatingCars(): Observable<any[]> {
    const participatingCars = this.getActiveCars().filter(car => this.canCarParticipate(car.car_id));
    
    if (participatingCars.length === 0) {
      this.logger.info('No participating cars found for coin consumption');
      return new Observable(observer => {
        observer.next([]);
        observer.complete();
      });
    }

    this.logger.info(`Consuming coins for ${participatingCars.length} participating cars (excluding manually blocked)`);
    
    const consumptionRequests = participatingCars.map(car => 
      this.externalApi.consumeCoin(car.car_id)
    );

    return forkJoin(consumptionRequests);
  }

  /**
   * Bloque toutes les voitures actives
   */
  blockAllActiveCars(): Observable<any[]> {
    const activeCars = this.getActiveCars();
    
    if (activeCars.length === 0) {
      this.logger.info('No active cars found to block');
      return new Observable(observer => {
        observer.next([]);
        observer.complete();
      });
    }

    this.logger.info(`Blocking ${activeCars.length} active cars`);
    
    const blockRequests = activeCars.map(car => 
      this.externalApi.blockCar(car.car_id, true)
    );

    return forkJoin(blockRequests);
  }

  /**
   * Débloque toutes les voitures actives
   */
  unblockAllActiveCars(): Observable<any[]> {
    const activeCars = this.getActiveCars();
    
    if (activeCars.length === 0) {
      this.logger.info('No active cars found to unblock');
      return new Observable(observer => {
        observer.next([]);
        observer.complete();
      });
    }

    this.logger.info(`Unblocking ${activeCars.length} active cars`);
    
    const unblockRequests = activeCars.map(car => 
      this.externalApi.blockCar(car.car_id, false)
    );

    return forkJoin(unblockRequests);
  }

  /**
   * Bloque ou débloque une voiture spécifique
   */
  toggleCarBlock(carId: number, blocked: boolean): Observable<any> {
    return this.externalApi.blockCar(carId, blocked);
  }

  /**
   * Remet une voiture à l'état normal
   */
  resetCarToNormal(carId: number): Observable<any> {
    return this.externalApi.resetCarToNormal(carId);
  }

  /**
   * Cycle entre les 3 états : bloqué → débloqué → normal → bloqué
   */
  cycleCarState(carId: number): Observable<any> {
    const car = this.externalApi.getCarById(carId);
    if (!car) {
      throw new Error(`Car ${carId} not found`);
    }

    // Déterminer l'état actuel et passer au suivant
    if (car.manually_blocked) {
      // État actuel : bloqué manuellement → passer à débloqué manuellement
      return this.externalApi.blockCar(carId, false);
    } else if (car.manually_unblocked) {
      // État actuel : débloqué manuellement → passer à normal
      return this.externalApi.resetCarToNormal(carId);
    } else {
      // État actuel : normal → passer à bloqué manuellement
      return this.externalApi.blockCar(carId, true);
    }
  }
}