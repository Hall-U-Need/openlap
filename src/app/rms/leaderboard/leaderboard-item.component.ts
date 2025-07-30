import { Component, Input, OnInit, OnDestroy } from '@angular/core';
import { Subscription } from 'rxjs';

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

  isEditingName = false;
  editingName = '';
  private subscription = new Subscription();

  constructor(
    private settings: AppSettings,
    private driverEditService: DriverEditService,
    private carSyncService: CarSyncService
  ) {}

  ngOnInit() {
    // S'abonner aux changements d'état d'édition
    this.subscription.add(
      this.driverEditService.editingState$.subscribe(state => {
        this.isEditingName = this.driverEditService.isEditing(this.item.id);
        if (this.isEditingName) {
          this.editingName = this.driverEditService.getEditingName(this.item.id);
        }
      })
    );
  }

  ngOnDestroy() {
    this.subscription.unsubscribe();
  }

  abs(n: number) {
    return n < 0 ? -n : n;
  }

  startEditName(event?: Event) {
    if (event) {
      event.stopPropagation();
      event.preventDefault();
    }
    
    this.driverEditService.startEditing(this.item.id, this.item.driver?.name || '');
    
    // Focus sur le champ input après un petit délai
    setTimeout(() => {
      const inputElement = document.querySelector('.driver-name-input ion-input');
      if (inputElement) {
        (inputElement as any).setFocus();
      }
    }, 100);
  }

  async saveName() {
    const currentName = this.driverEditService.getEditingName(this.item.id);
    if (currentName.trim()) {
      try {
        const drivers = await this.settings.getDrivers().toPromise();
        const updatedDrivers = [...drivers];
        
        // Mettre à jour le nom du pilote
        if (updatedDrivers[this.item.id]) {
          updatedDrivers[this.item.id] = {
            ...updatedDrivers[this.item.id],
            name: currentName.trim(),
            code: this.generateCode(currentName.trim(), this.item.id, updatedDrivers)
          };
          
          await this.settings.setDrivers(updatedDrivers);
        }
      } catch (error) {
        console.error('Error saving driver name:', error);
      }
    }
    
    this.cancelEdit();
  }

  cancelEdit() {
    this.driverEditService.stopEditing();
  }

  onKeyPress(event: KeyboardEvent) {
    if (event.key === 'Enter') {
      this.saveName();
    } else if (event.key === 'Escape') {
      this.cancelEdit();
    }
  }

  onNameChange(newName: string) {
    this.driverEditService.updateEditingName(newName);
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
