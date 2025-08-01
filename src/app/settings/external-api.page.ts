import { Component, OnDestroy, OnInit } from '@angular/core';

import { AppSettings, ExternalApi } from '../app-settings';
import { ExternalApiService } from '../services/external-api.service';
import { I18nToastService } from '../services';

@Component({
  templateUrl: 'external-api.page.html'
})
export class ExternalApiPage implements OnDestroy, OnInit {

  externalApi = new ExternalApi();
  isTestingConnection = false;

  private subscription: any;

  constructor(
    private settings: AppSettings,
    private externalApiService: ExternalApiService,
    private toast: I18nToastService
  ) {}

  ngOnInit() {
    this.subscription = this.settings.getExternalApi().subscribe(externalApi => {
      this.externalApi = externalApi;
    });
  }

  ngOnDestroy() {
    this.subscription.unsubscribe();
  }

  save() {
    return this.settings.setExternalApi(this.externalApi);
  }

  testConnection() {
    if (!this.externalApi.enabled) {
      this.toast.showShortCenter('External API is disabled. Enable it first to test connection.');
      return;
    }

    if (!this.externalApi.apiUrl) {
      this.toast.showShortCenter('Please enter an API URL first.');
      return;
    }

    this.isTestingConnection = true;
    
    // Sauvegarder d'abord les paramètres
    this.save().then(() => {
      // Puis tester la connexion
      this.externalApiService.testConnection().subscribe({
        next: (success) => {
          if (success) {
            this.toast.showShortCenter('✅ Connection successful!');
          } else {
            this.toast.showShortCenter('❌ Connection failed. Check logs for details.');
          }
        },
        error: (error) => {
          this.toast.showShortCenter('❌ Connection failed. Check logs for details.');
        },
        complete: () => {
          this.isTestingConnection = false;
        }
      });
    });
  }
}