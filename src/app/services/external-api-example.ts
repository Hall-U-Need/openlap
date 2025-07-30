import { Injectable } from '@angular/core';
import { ExternalApiService, ExternalApiBackend } from '../services';

@Injectable({
  providedIn: 'root'
})
export class ExternalApiExampleService {
  
  constructor(private externalApiService: ExternalApiService) {}

  /**
   * Exemple d'utilisation du service API externe
   */
  initializeApiConnection(): void {
    // Configurer l'URL de l'API (remplacez par l'URL réelle)
    this.externalApiService.setApiUrl('http://votre-api-url.com/api');
    
    // Configurer l'intervalle de polling (optionnel)
    this.externalApiService.setPollingInterval(500); // 500ms
    
    // Démarrer le polling
    this.externalApiService.startPolling();
    
    // S'abonner aux données des voitures
    this.externalApiService.cars$.subscribe(cars => {
      console.log('Données des voitures reçues:', cars);
      
      // Traitement des données des voitures
      cars.forEach(car => {
        if (car.active && car.accelerator_percent > 0) {
          console.log(`Voiture ${car.name} accélère à ${car.accelerator_percent}%`);
        }
      });
    });
    
    // S'abonner aux données des accepteurs de pièces
    this.externalApiService.coinAcceptors$.subscribe(acceptors => {
      console.log('Données des accepteurs de pièces:', acceptors);
      
      // Traitement des accepteurs de pièces
      acceptors.forEach(acceptor => {
        if (acceptor.coin_count > 0) {
          console.log(`Accepteur ${acceptor.id}: ${acceptor.coin_count} pièces`);
        }
      });
    });
  }

  /**
   * Exemple d'utilisation avec le backend Carrera
   */
  createExternalApiBackend(): ExternalApiBackend {
    return new ExternalApiBackend(this.externalApiService);
  }

  /**
   * Arrêter la connexion API
   */
  stopApiConnection(): void {
    this.externalApiService.stopPolling();
  }

  /**
   * Obtenir des informations sur une voiture spécifique
   */
  getCarInfo(carId: number): void {
    const car = this.externalApiService.getCarById(carId);
    if (car) {
      console.log(`Voiture ${car.name}:`, {
        id: car.car_id,
        acceleration: car.accelerator_percent,
        active: car.active,
        button_pressed: car.button_pressed,
        last_seen: car.last_seen
      });
    } else {
      console.log(`Voiture avec ID ${carId} non trouvée`);
    }
  }
}