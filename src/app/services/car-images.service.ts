import { Injectable } from '@angular/core';

export interface CarImage {
  filename: string;
  displayName: string;
  path: string;
}

@Injectable({
  providedIn: 'root'
})
export class CarImagesService {
  private readonly carImagesPath = 'assets/web-display/cars/';

  // Liste générée automatiquement par scripts/generate-car-images.js
  // Ne pas modifier manuellement - exécutez 'npm run generate-car-images' pour régénérer
  private readonly availableImages: CarImage[] = [
    {
      filename: 'BMW M4 GT3 Sheldon van der Linde.webp',
      displayName: 'BMW M4 GT3 Sheldon van der Linde',
      path: 'assets/web-display/cars/BMW M4 GT3 Sheldon van der Linde.webp'
    },
    {
      filename: 'Corvette C7 GT3-R Callaway Competition.webp',
      displayName: 'Corvette C7 GT3-R Callaway Competition',
      path: 'assets/web-display/cars/Corvette C7 GT3-R Callaway Competition.webp'
    },
    {
      filename: 'Ferrari 296 GT3 AF Corse.webp',
      displayName: 'Ferrari 296 GT3 AF Corse',
      path: 'assets/web-display/cars/Ferrari 296 GT3 AF Corse.webp'
    },
    {
      filename: 'Mercedes AMG GT3 Team Winward D.Schumacher.webp',
      displayName: 'Mercedes AMG GT3 D.Schumacher',
      path: 'assets/web-display/cars/Mercedes AMG GT3 Team Winward D.Schumacher.webp'
    },
    {
      filename: 'NASCAR CAMARO ZL1 Hendrick Motorsports, Alex Bowman.webp',
      displayName: 'NASCAR CAMARO ZL1 Alex Bowman',
      path: 'assets/web-display/cars/NASCAR CAMARO ZL1 Hendrick Motorsports, Alex Bowman.webp'
    },
    {
      filename: 'NASCAR CAMARO ZL1 Hendrick Motorsports, Chase Elliott.webp',
      displayName: 'NASCAR CAMARO ZL1 Chase Elliott',
      path: 'assets/web-display/cars/NASCAR CAMARO ZL1 Hendrick Motorsports, Chase Elliott.webp'
    }
  ];

  constructor() {}

  getAvailableImages(): CarImage[] {
    return this.availableImages;
  }

  getImagePath(filename: string | undefined): string | undefined {
    if (!filename) return undefined;
    const image = this.availableImages.find(img => img.filename === filename);
    return image?.path;
  }

  getImageDisplayName(filename: string | undefined): string | undefined {
    if (!filename) return undefined;
    const image = this.availableImages.find(img => img.filename === filename);
    return image?.displayName;
  }
}
