import { Component, OnDestroy, OnInit } from '@angular/core';

import { ModalController } from '@ionic/angular';

import { take } from 'rxjs/operators';

import { TranslateService } from '@ngx-translate/core';

import { Observable } from 'rxjs';

import { AppSettings, Driver } from '../app-settings';
import { AppService, ControlUnitService, LoggingService, SpeechService } from '../services';
import { CarImagesService } from '../services/car-images.service';

import { ColorComponent } from './color.component';
import { CarImageComponent } from './car-image.component';

import { ControlUnitButton } from '../carrera';

@Component({
  templateUrl: 'drivers.page.html'
})
export class DriversPage implements OnDestroy, OnInit {

  drivers: Driver[];

  orientation: Observable<string>;

  readonly placeholder = 'Driver {{number}}';

  private shouldClearOnType: { [key: number]: boolean } = {};

  constructor(
    private app: AppService,
    private cu: ControlUnitService,
    private logger: LoggingService,
    private settings: AppSettings,
    private mc: ModalController,
    private speech: SpeechService,
    private translate: TranslateService,
    public carImagesService: CarImagesService)
  {
    this.orientation = app.orientation;
  }

  ngOnInit() {
    this.settings.getDrivers().pipe(take(1)).toPromise().then(drivers => {
      this.drivers = drivers;
    }).catch(error => {
      this.logger.error('Error getting drivers', error);
    });
  }

  ngOnDestroy() {
    this.settings.setDrivers(this.drivers).catch(error => {
      this.logger.error('Error setting drivers', error);
    });
  }

  getCode(name: string, id: number) {
    let chars = name.replace(/\W/g, '').toUpperCase();  // TODO: proper Unicode support
    let codes = this.drivers.filter((_, index) => index !== id).map(obj => obj.code);
    for (let n = 2; n < chars.length; ++n) {
      let s = chars.substr(0, 2) + chars.substr(n, 1);
      if (codes.indexOf(s) === -1) {
        return s;
      }
    }
    return undefined;
  }

  reorderItems(event: any) {
    // TODO: optionally stick color to controller ID
    //let colors = this.drivers.map(driver => driver.color);
    let element = this.drivers[event.detail.from];
    this.drivers.splice(event.detail.from, 1);
    this.drivers.splice(event.detail.to, 0, element);
    /*
    colors.forEach((color, index) => {
      this.drivers[index].color = color;
    });
    */
    event.detail.complete();
  }

  chooseColor(id: number) {
    return this.mc.create({
      component: ColorComponent,
      componentProps: {id: id, driver: this.drivers[id]}
    }).then(modal => {
      modal.onDidDismiss().then(detail => {
        if (detail.data) {
          this.drivers[id].color = detail.data;
        }
      });
      modal.present();
    });
  }

  chooseCarImage(id: number) {
    return this.mc.create({
      component: CarImageComponent,
      componentProps: {id: id, driver: this.drivers[id]}
    }).then(modal => {
      modal.onDidDismiss().then(detail => {
        // detail.data peut être une chaîne (filename) ou undefined (aucune image)
        // On vérifie que le modal a retourné quelque chose (pas annulé)
        if (detail.role === 'backdrop' || detail.role === 'gesture') {
          // Modal fermé sans sélection, ne rien faire
          return;
        }
        // Mettre à jour l'image (peut être undefined pour supprimer)
        this.drivers[id].carImage = detail.data;
      });
      modal.present();
    });
  }

  speak(id: number) {
    this.getDriverName(id).then(name => {
      this.speech.speak(name);
    })
  }

  pressCodeButton() {
    this.cu.value.trigger(ControlUnitButton.CODE);
  }

  onChangeName(event) {
    event?.target?.getInputElement().then(e => e.blur());
  }

  onFocusName(event, id: number) {
    // Marquer qu'on doit effacer à la première frappe
    this.shouldClearOnType[id] = true;
    // Sélectionner tout le texte pour qu'il soit remplacé à la première frappe
    event?.target?.getInputElement().then(e => e.select());
  }

  onNameChange(newName: string, id: number) {
    // Si on doit effacer à la première frappe, le faire maintenant
    if (this.shouldClearOnType[id] && newName) {
      this.shouldClearOnType[id] = false;
      // Garder seulement la dernière lettre tapée
      this.drivers[id].name = newName.charAt(newName.length - 1);
      this.drivers[id].code = this.getCode(this.drivers[id].name, id);
    } else {
      // Mise à jour normale
      this.drivers[id].name = newName || undefined;
      this.drivers[id].code = this.getCode(newName || '', id);
    }
  }

  private getDriverName(id) {
    if (this.drivers[id] && this.drivers[id].name) {
      return Promise.resolve(this.drivers[id].name);
    } else {
      return this.translate.get(this.placeholder, {number: id + 1}).toPromise();
    }
  }
}
