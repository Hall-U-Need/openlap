import { Injectable } from '@angular/core';
import { Subject } from 'rxjs';

export interface TuningUpdate {
  carId: number;
  speed?: number;
  brake?: number;
  fuel?: number;
}

@Injectable({
  providedIn: 'root'
})
export class TuningSyncService {
  private tuningUpdateSubject = new Subject<TuningUpdate>();
  public tuningUpdate$ = this.tuningUpdateSubject.asObservable();

  /**
   * Notifier un changement de paramètres de tuning pour une voiture
   */
  notifyTuningUpdate(update: TuningUpdate): void {
    this.tuningUpdateSubject.next(update);
  }

  /**
   * Notifier un changement de paramètres pour toutes les voitures
   */
  notifyTuningUpdateAll(speed?: number, brake?: number, fuel?: number): void {
    for (let carId = 0; carId < 6; carId++) {
      this.tuningUpdateSubject.next({ carId, speed, brake, fuel });
    }
  }
}
