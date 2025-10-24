import { Component, Input, OnInit, OnDestroy, ViewChild, ElementRef } from '@angular/core';
import { Subscription } from 'rxjs';
import { take } from 'rxjs/operators';
import { IonInput } from '@ionic/angular';

import { LeaderboardItem } from './leaderboard.component';
import { AppSettings } from '../../app-settings';
import { DriverEditService } from '../../services/driver-edit.service';
import { CarSyncService } from '../../services/car-sync.service';

@Component({
  selector: 'leaderboard-item',
  styleUrls: ['leaderboard.component.scss'],
  templateUrl: 'leaderboard-item.component.html'
})
export class LeaderboardItemComponent implements OnInit, OnDestroy {
  @Input() fields: string[];
  @Input() item: LeaderboardItem;
  @Input() ranked: LeaderboardItem[];
  @Input() best: number[];
  @ViewChild('nameInput') nameInput: IonInput;

  isEditingName = false;
  private shouldClearOnType = false;

  constructor(
    private settings: AppSettings,
    private driverEditService: DriverEditService,
    private carSyncService: CarSyncService
  ) {}

  ngOnInit() {
  }

  ngOnDestroy() {
  }

  abs(n: number) {
    return n < 0 ? -n : n;
  }

  startEditName(event?: Event) {
    if (event) {
      event.stopPropagation();
      event.preventDefault();
    }

    // IMPORTANT: Notifier le service AVANT de passer en mode édition
    // pour que le parent préserve les données avant la prochaine mise à jour
    this.driverEditService.startEditing(this.item.id, this.item.driver?.name || '');

    // Ensuite passer en mode édition
    this.isEditingName = true;
    this.shouldClearOnType = true;

    // Focus sur le champ input après un petit délai
    setTimeout(() => {
      if (this.nameInput) {
        this.nameInput.setFocus();
        // Sélectionner tout le texte pour qu'il soit remplacé à la première frappe
        this.nameInput.getInputElement().then(input => {
          input.select();
        });
      }
    }, 150);
  }

  onFocusName(event) {
    // Ne rien faire au focus, on gère la sélection dans startEditName
  }

  onBlurName(event) {
    // Sauvegarder quand le champ perd le focus
    this.saveName();
  }

  onChangeName(event) {
    // Ne rien faire ici, juste pour compatibilité
  }

  async onNameChange(newName: string) {
    // Si on doit effacer à la première frappe, le faire maintenant
    if (this.shouldClearOnType && newName) {
      this.shouldClearOnType = false;
      // Si l'utilisateur tape quelque chose, on efface tout et on met juste la nouvelle lettre
      this.item.driver.name = newName.charAt(newName.length - 1);
      return;
    }

    // Mettre à jour le code en fonction du nouveau nom
    if (newName && newName.trim()) {
      try {
        const drivers = await this.settings.getDrivers().toPromise();
        this.item.driver.code = this.generateCode(newName, this.item.id, drivers);
      } catch (error) {
        console.error('Error generating code:', error);
      }
    } else {
      this.item.driver.code = undefined;
    }
  }

  onKeyPress(event: KeyboardEvent) {
    if (event.key === 'Enter') {
      event.preventDefault();
      event.stopPropagation();
      this.saveName();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      this.isEditingName = false;
      // Notifier le service qu'on annule l'édition
      this.driverEditService.stopEditing();
    }
  }

  async saveName() {
    const newName = this.item.driver.name?.trim();
    console.log('Saving name for driver', this.item.id, ':', newName);

    try {
      // Récupérer les drivers actuels
      const drivers = await this.settings.getDrivers().pipe(
        take(1)
      ).toPromise();

      console.log('Current drivers:', drivers);

      // Créer une copie et mettre à jour
      const updatedDrivers = drivers.map((driver, index) => {
        if (index === this.item.id) {
          const code = newName ? this.generateCode(newName, this.item.id, drivers) : undefined;
          console.log('Updating driver', index, 'with name:', newName, 'code:', code);
          return {
            ...driver,
            name: newName || undefined,
            code: code
          };
        }
        return driver;
      });

      console.log('Updated drivers:', updatedDrivers);

      // Sauvegarder
      await this.settings.setDrivers(updatedDrivers);
      console.log('Name saved successfully');

      // Mettre à jour l'affichage local
      this.item.driver.name = newName || undefined;
      this.item.driver.code = updatedDrivers[this.item.id].code;

      // Fermer le mode édition
      this.isEditingName = false;
      // Notifier le service qu'on a fini l'édition
      this.driverEditService.stopEditing();
    } catch (error) {
      console.error('Error saving driver name:', error);
    }
  }

  toggleCarBlock(event?: Event) {
    if (event) {
      event.stopPropagation();
      event.preventDefault();
    }
    
    const carId = this.item.id + 1; // Convert 0-based index to 1-based car ID
    
    // Utiliser le cycle à 3 états
    this.carSyncService.cycleCarState(carId).subscribe({
      next: (response) => {
        console.log(`Car ${carId} state cycled:`, response);
        // The state will be updated through the normal API polling cycle
      },
      error: (error) => {
        console.error(`Failed to cycle car ${carId} state:`, error);
      }
    });
  }

  private generateCode(name: string, driverIndex: number, allDrivers: any[]): string {
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
}
