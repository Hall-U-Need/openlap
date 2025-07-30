import { Observable, from, Subject, NextObserver } from 'rxjs';
import { map } from 'rxjs/operators';

import { Backend } from './backend';
import { Peripheral } from '../carrera';
import { ExternalApiService, ApiCar } from '../services';

export class ExternalApiPeripheral implements Peripheral {
  public type = 'external-api';
  public address = 'external-api-connection';

  constructor(
    public name: string,
    private apiService: ExternalApiService
  ) {}

  connect(connected?: NextObserver<void>, disconnected?: NextObserver<void>): Subject<ArrayBuffer> {
    const subject = new Subject<ArrayBuffer>();
    
    this.apiService.startPolling();
    
    // Convertir les données de l'API en ArrayBuffer pour le Subject
    this.apiService.cars$.subscribe(cars => {
      cars.forEach(car => {
        const buffer = this.convertCarToArrayBuffer(car);
        subject.next(buffer);
      });
    });

    if (connected) {
      connected.next();
    }

    return subject;
  }

  equals(other: any): boolean {
    return other && other.type === this.type && other.address === this.address;
  }

  private convertCarToArrayBuffer(car: ApiCar): ArrayBuffer {
    // Créer un buffer pour simuler les données Carrera
    const buffer = new ArrayBuffer(16);
    const view = new DataView(buffer);
    
    // Adapter les données de l'API au format attendu par Carrera
    view.setUint8(0, car.car_id);
    view.setUint8(1, car.accelerator_percent);
    view.setUint8(2, car.button_pressed ? 1 : 0);
    view.setUint8(3, car.active ? 1 : 0);
    view.setUint32(4, car.last_seen, true);
    view.setUint32(8, car.frame_count, true);
    view.setUint32(12, car.throttle_raw, true);
    
    return buffer;
  }
}

export class ExternalApiBackend extends Backend {
  
  constructor(private apiService: ExternalApiService) {
    super();
  }

  scan(): Observable<Peripheral> {
    // Simuler la découverte d'un périphérique API
    const peripheral = new ExternalApiPeripheral(
      'External API Connection',
      this.apiService
    );
    
    return from([peripheral]);
  }
}