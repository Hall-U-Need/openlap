import { Component, OnDestroy, OnInit } from '@angular/core';

import { AppSettings, WebDisplay } from '../app-settings';
import { WebDisplayService } from '../services/web-display.service';
import { I18nToastService, LoggingService } from '../services';

@Component({
  templateUrl: 'web-display.page.html'
})
export class WebDisplayPage implements OnDestroy, OnInit {

  webDisplay = new WebDisplay();
  isServerRunning = false;
  serverUrl: string | null = null;
  serverIP: string | null = null;
  detectedIP: string | null = null;
  connectedClients = 0;
  isStartingServer = false;
  wsServerStatus = false;

  private subscription: any;
  private statusSubscription: any;

  constructor(
    private settings: AppSettings,
    private webDisplayService: WebDisplayService,
    private toast: I18nToastService,
    private logger: LoggingService
  ) {}

  ngOnInit() {
    this.subscription = this.settings.getWebDisplay().subscribe(webDisplay => {
      this.webDisplay = webDisplay;
    });

    this.statusSubscription = this.webDisplayService.serverStatus$.subscribe(status => {
      this.isServerRunning = status;
      this.serverUrl = status ? this.webDisplayService.getServerUrl() : null;
      this.serverIP = status ? this.webDisplayService.getServerIP() : null;
      this.detectedIP = this.webDisplayService.getLocalIP();
      this.connectedClients = this.webDisplayService.getConnectedClientsCount();
      this.wsServerStatus = this.webDisplayService.getWebSocketServerStatus();
    });

    // Initial status check
    this.isServerRunning = this.webDisplayService.isRunning();
    this.serverUrl = this.webDisplayService.getServerUrl();
    this.serverIP = this.webDisplayService.getServerIP();
    this.detectedIP = this.webDisplayService.getLocalIP();
    this.wsServerStatus = this.webDisplayService.getWebSocketServerStatus();
  }

  ngOnDestroy() {
    if (this.subscription) {
      this.subscription.unsubscribe();
    }
    if (this.statusSubscription) {
      this.statusSubscription.unsubscribe();
    }
  }

  save() {
    return this.settings.setWebDisplay(this.webDisplay);
  }

  async toggleServer() {
    if (!this.webDisplay.enabled) {
      this.toast.showShortCenter('Web Display is disabled. Enable it first.');
      return;
    }

    this.isStartingServer = true;

    try {
      // Save settings first
      await this.save();

      if (this.isServerRunning) {
        await this.webDisplayService.stopServer();
        this.toast.showShortCenter('Web Display server stopped.');
      } else {
        const started = await this.webDisplayService.startServer();
        if (started) {
          this.toast.showShortCenter('Web Display server started successfully!');
          this.logger.info('Web Display server started on port', this.webDisplay.port);
        } else {
          this.toast.showShortCenter('Failed to start Web Display server. Check logs for details.');
        }
      }
    } catch (error) {
      this.logger.error('Error toggling web display server:', error);
      this.toast.showShortCenter('Error managing server. Check logs for details.');
    } finally {
      this.isStartingServer = false;
    }
  }

  openWebDisplay() {
    if (this.serverUrl) {
      // In Cordova, open external browser
      if ((window as any).cordova) {
        (window as any).cordova.InAppBrowser.open(this.serverUrl, '_system');
      } else {
        window.open(this.serverUrl, '_blank');
      }
    }
  }

  copyServerUrl() {
    if (this.serverUrl && navigator.clipboard) {
      navigator.clipboard.writeText(this.serverUrl).then(() => {
        this.toast.showShortCenter('mDNS URL copied to clipboard!');
      }).catch(() => {
        this.toast.showShortCenter('Could not copy URL. Please copy manually.');
      });
    }
  }

  copyServerIP() {
    if (this.serverIP && navigator.clipboard) {
      navigator.clipboard.writeText(this.serverIP).then(() => {
        this.toast.showShortCenter('IP address copied to clipboard!');
      }).catch(() => {
        this.toast.showShortCenter('Could not copy IP. Please copy manually.');
      });
    }
  }

  getQRCodeUrl(): string {
    if (!this.serverUrl) return '';
    
    // Generate QR code using a free service
    const encodedUrl = encodeURIComponent(this.serverUrl);
    return `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodedUrl}`;
  }

  forceDriversUpdate() {
    // OLD APPROACH REMOVED - data now comes directly from RMS component
    this.toast.showShortCenter('Data now comes directly from RMS - old force update removed');
  }
}