import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';

export interface DriverEditState {
  driverId: number;
  editingName: string;
}

@Injectable({
  providedIn: 'root'
})
export class DriverEditService {
  private editingState = new BehaviorSubject<DriverEditState | null>(null);
  
  public editingState$ = this.editingState.asObservable();

  startEditing(driverId: number, currentName: string) {
    this.editingState.next({
      driverId,
      editingName: currentName
    });
  }

  updateEditingName(name: string) {
    const current = this.editingState.value;
    if (current) {
      this.editingState.next({
        ...current,
        editingName: name
      });
    }
  }

  stopEditing() {
    this.editingState.next(null);
  }

  isEditing(driverId: number): boolean {
    const current = this.editingState.value;
    return current ? current.driverId === driverId : false;
  }

  getEditingDriverId(): number | undefined {
    const current = this.editingState.value;
    return current?.driverId;
  }

  getEditingName(driverId: number): string {
    const current = this.editingState.value;
    return current && current.driverId === driverId ? current.editingName : '';
  }
}