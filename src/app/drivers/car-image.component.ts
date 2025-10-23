import { Component, Input, OnInit } from '@angular/core';
import { ModalController } from '@ionic/angular';
import { CarImagesService, CarImage } from '../services/car-images.service';
import { Driver } from '../app-settings';

@Component({
  selector: 'car-image-picker',
  template: `
    <ion-header>
      <ion-toolbar>
        <ion-buttons slot="start">
          <ion-button (click)="dismiss()">
            <ion-icon name="close"></ion-icon>
          </ion-button>
        </ion-buttons>
        <ion-title>Choisir une voiture</ion-title>
        <ion-buttons slot="end">
          <ion-button (click)="clearSelection()" color="danger">
            Aucune
          </ion-button>
        </ion-buttons>
      </ion-toolbar>
    </ion-header>
    <ion-content class="ion-padding">
      <ion-grid>
        <ion-row>
          <ion-col size="12" size-md="6" size-lg="4" *ngFor="let image of availableImages">
            <ion-card
              button
              (click)="selectImage(image.filename)"
              [class.selected]="image.filename === selectedImage"
            >
              <img [src]="image.path" [alt]="image.displayName" />
              <ion-card-header>
                <ion-card-title class="ion-text-center">
                  {{ image.displayName }}
                </ion-card-title>
              </ion-card-header>
            </ion-card>
          </ion-col>
        </ion-row>
      </ion-grid>
    </ion-content>
  `,
  styles: [`
    ion-card {
      margin: 8px;
      transition: all 0.3s ease;
    }

    ion-card.selected {
      border: 3px solid var(--ion-color-primary);
      box-shadow: 0 0 15px var(--ion-color-primary);
    }

    ion-card img {
      width: 100%;
      height: 200px;
      object-fit: cover;
    }

    ion-card-title {
      font-size: 0.9rem;
      padding: 8px 0;
    }
  `]
})
export class CarImageComponent implements OnInit {
  @Input() id: number = 0;
  @Input() driver: Driver = { color: '#ffffff' };

  availableImages: CarImage[] = [];
  selectedImage: string | undefined;

  constructor(
    private modalCtrl: ModalController,
    private carImagesService: CarImagesService
  ) {}

  ngOnInit() {
    this.availableImages = this.carImagesService.getAvailableImages();
    this.selectedImage = this.driver.carImage;
  }

  selectImage(filename: string) {
    this.selectedImage = filename;
    this.dismiss(filename);
  }

  clearSelection() {
    this.dismiss(undefined);
  }

  dismiss(data?: string) {
    this.modalCtrl.dismiss(data);
  }
}
