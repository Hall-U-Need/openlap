#!/usr/bin/env node

/**
 * Script pour générer automatiquement la liste des images de voitures
 * Scanne le répertoire assets/web-display/cars/ et génère car-images.service.ts
 */

const fs = require('fs');
const path = require('path');

const CARS_DIR = path.join(__dirname, '../src/assets/web-display/cars');
const OUTPUT_FILE = path.join(__dirname, '../src/app/services/car-images.service.ts');

// Fonction pour extraire un nom d'affichage lisible du nom de fichier
function generateDisplayName(filename) {
  // Enlever l'extension
  let name = filename.replace(/\.(webp|jpg|jpeg|png)$/i, '');

  // Remplacer les patterns courants
  name = name.replace(/Hendrick Motorsports,?\s*/gi, '');
  name = name.replace(/Team Winward\s*/gi, '');

  return name;
}

// Lire tous les fichiers du répertoire
console.log('📂 Scanning directory:', CARS_DIR);

if (!fs.existsSync(CARS_DIR)) {
  console.error('❌ Directory not found:', CARS_DIR);
  process.exit(1);
}

const files = fs.readdirSync(CARS_DIR)
  .filter(file => /\.(webp|jpg|jpeg|png)$/i.test(file))
  .sort();

console.log(`✅ Found ${files.length} car images`);

// Générer les entrées
const imageEntries = files.map(file => {
  const displayName = generateDisplayName(file);
  return `    {
      filename: '${file}',
      displayName: '${displayName}',
      path: 'assets/web-display/cars/${file}'
    }`;
}).join(',\n');

// Générer le contenu du service
const serviceContent = `import { Injectable } from '@angular/core';

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
${imageEntries}
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
`;

// Écrire le fichier
fs.writeFileSync(OUTPUT_FILE, serviceContent, 'utf8');

console.log('✅ Generated:', OUTPUT_FILE);
console.log('📝 Images included:');
files.forEach(file => console.log(`   - ${file}`));
console.log('\n✨ Done! Run your build to see the changes.');
