import { Injectable } from '@angular/core';

import { Platform } from '@ionic/angular';

import { BLE, BLEScanOptions } from '@awesome-cordova-plugins/ble/ngx';

import { NextObserver, Observable, Subject, empty, from, interval, of } from 'rxjs';
import { catchError, distinct, distinctUntilChanged, filter, finalize, map, startWith, switchMap, tap } from 'rxjs/operators';

import { Backend } from './backend';
import { DataView, Peripheral } from '../carrera';
import { LoggingService } from '../services';

const SERVICE_UUID = '39df7777-b1b4-b90b-57f1-7144ae4e4a6a';
const OUTPUT_UUID = '39df8888-b1b4-b90b-57f1-7144ae4e4a6a';
const NOTIFY_UUID = '39df9999-b1b4-b90b-57f1-7144ae4e4a6a';

const DOLLAR = '$'.charCodeAt(0);

function bufferToString(buffer: ArrayBuffer) {
  // TODO: special DataView.convertToString() method?
  const v = new DataView(buffer);
  return v.toString();
}

class BLEPeripheral implements Peripheral {

  type = 'ble';

  name: string;

  address: string;

  lastWritten: string;

  constructor(device: any, private ble: BLE, private logger: LoggingService) {
    this.name = device.name;
    this.address = device.id;
  }

  connect(connected?: NextObserver<void>, disconnected?: NextObserver<void>) {
    const observable = this.createObservable(connected, disconnected)
    const observer = this.createObserver(disconnected);
    return Subject.create(observer, observable);
  }

  equals(other: Peripheral) {
    return other && other.type === this.type && other.address === this.address;
  }

  private createObservable(connected?: NextObserver<void>, disconnected?: NextObserver<void>) {
    return new Observable<ArrayBuffer>(subscriber => {
      this.logger.info('Connecting to BLE device ' + this.address);
      let isConnected = false;
      let lastReceived = null;
      this.lastWritten = null;
      this.ble.connect(this.address).subscribe({
        next: peripheral => {
          this.logger.info('Connected to BLE device', peripheral);
          isConnected = true;
          this.ble.startNotification(this.address, SERVICE_UUID, NOTIFY_UUID).subscribe({
            next: ([data, _]) => {
              if (this.logger.isDebugEnabled()) {
                const s = bufferToString(data);
                if (s !== lastReceived) {
                  this.logger.debug('BLE received ' + s);
                  lastReceived = s;
                }
              }
              this.onNotify(data, subscriber);
            },
            error: err => this.onError(err, subscriber)
          });
          if (connected) {
            // this should resolve *after* this.ble.startNotification is installed
            this.ble.isConnected(this.address).then(() => {
              this.logger.info('BLE device ready');
              if (isConnected) {
                connected.next(undefined);
              }
            }).catch((err) => {
              this.logger.error('BLE device not connected', err);
            });
          }
        },
        error: obj => {
          if (obj instanceof Error) {
            this.logger.error('BLE connection error', obj);
            subscriber.error(obj);
          } else if (!isConnected) {
            this.logger.error('BLE connection error', obj);
            subscriber.error(new Error('Connection error'));
          } else {
            this.logger.info('BLE device disconnected', obj);
            subscriber.complete();
          }
          isConnected = false;
        },
        complete: () => {
          this.logger.info('BLE connection closed');
          subscriber.complete();
          isConnected = false;
        }
      });
      return () => {
        this.disconnect(disconnected);
      };
    });
  }

  private createObserver(disconnected?: NextObserver<void>) {
    return {
      next: (value: ArrayBuffer) => {
        if (this.logger.isDebugEnabled()) {
          const s = bufferToString(value);
          if (s !== this.lastWritten) {
            this.logger.debug('BLE write ' + s);
            this.lastWritten = s;
          }
        }
        this.write(value);
      },
      error: (err: any) => this.logger.error('BLE user error', err),
      complete: () => this.disconnect(disconnected)
    };
  }

  private write(value: ArrayBuffer) {
    this.ble.writeWithoutResponse(this.address, SERVICE_UUID, OUTPUT_UUID, value).catch(error => {
      this.logger.error('BLE write error', error);
    });
  }

  private disconnect(disconnected?: NextObserver<void>) {
    this.logger.debug('Closing BLE connection to ' + this.address);
    this.ble.disconnect(this.address).then(() => {
      this.logger.info('BLE disconnected from ' + this.address);
    }).catch(error => {
      this.logger.error('BLE disconnect error', error);
    }).then(() => {
      if (disconnected) {
        disconnected.next(undefined);
      }
    });
  }

  private onNotify(data, subscriber) {
    // strip trailing '$' and prepend missing '0'/'?' for notifications
    // TODO: only handle version specially and drop '?'?
    const view = new Uint8Array(data);
    if (view[view.length - 1] == DOLLAR) {
      view.copyWithin(1, 0);
      view[0] = view.length == 6 ? 0x30 : 0x3f;
    }
    subscriber.next(view.buffer);
  }

  private onError(error, subscriber) {
    subscriber.error(error);
  }
}

@Injectable()
export class BLEBackend extends Backend {

  private scanner: Observable<any>;

  private devices = new Map<string, any>();

  constructor(private ble: BLE, private logger: LoggingService, private platform: Platform) {
    super();

    this.scanner = from(this.platform.ready()).pipe(
      switchMap(readySource => {
        if (readySource == 'cordova') {
          // Check if device supports Bluetooth (especially for Android TV)
          this.checkBluetoothSupport();
          
          // TODO: use BLE state listeners when available in ionic-native?
          return interval(1000).pipe(
            startWith(null),
            switchMap(() => {
              return from(this.ble.isEnabled().then(() => true, () => false).catch(error => {
                this.logger.warn('Bluetooth check failed (possibly not supported on this device):', error);
                return false;
              }));
            })
          );
        } else {
          return of(false);
        }
      }),
      distinctUntilChanged(),
      switchMap(enabled => {
        if (enabled) {
          this.logger.info('Start scanning for BLE devices');
          
          // Check if this is Android TV and use different scan options
          const userAgent = navigator.userAgent.toLowerCase();
          const isAndroidTV = userAgent.includes('android') && 
                             (userAgent.includes('tv') || userAgent.includes('afts') || userAgent.includes('aftm'));
          const androidVersion = this.getAndroidVersion();
          const isOldAndroid = parseInt(androidVersion.split('.')[0]) < 6;
          
          // Use minimal scan options for old Android versions
          const scanOptions = isOldAndroid ? {
            // Android 5.1 - use minimal options
          } : isAndroidTV ? {
            reportDuplicates: false,
            scanMode: "balanced"  // Most compatible option for Android TV
          } : {
            reportDuplicates: true,
            scanMode: "lowLatency"
          };
          
          this.logger.info('BLE scan options:', scanOptions);
          this.logger.info('Android version detected:', androidVersion, isOldAndroid ? '(old Android - using basic scan)' : '');
          
          // For Android 5.1, use basic scan without options
          const scanObservable = isOldAndroid ? 
            this.ble.startScan([]) : 
            this.ble.startScanWithOptions([], scanOptions as BLEScanOptions);
          
          return scanObservable.pipe(
            tap(() => this.logger.info('BLE scan started successfully with options:', scanOptions)),
            finalize(() => {
              this.logger.info('Stop scanning for BLE devices');
              this.logger.info(`Total unique devices discovered: ${this.devices.size}`);
              if (this.devices.size === 0) {
                this.logger.warn('No BLE devices were discovered during scan');
                this.logger.warn('Possible causes:');
                this.logger.warn('1. No Bluetooth devices are advertising nearby');
                this.logger.warn('2. Location permission not granted');
                this.logger.warn('3. Bluetooth scanning may be restricted on this device');
                this.logger.warn('4. Control Unit may not be powered on or in pairing mode');
              }
            }),
            catchError(error => {
              this.logger.error('BLE scanning failed:', error);
              this.logger.error('Error details:', JSON.stringify(error));
              
              // Try fallback scan with simpler options for Android TV or old Android
              if (isAndroidTV && !isOldAndroid) {
                this.logger.info('Trying fallback BLE scan with basic options...');
                const fallbackOptions = {
                  reportDuplicates: false,
                  scanMode: "balanced"  // Most compatible option
                };
                return this.ble.startScanWithOptions([], fallbackOptions as BLEScanOptions).pipe(
                  catchError(fallbackError => {
                    this.logger.error('Fallback BLE scan with options failed:', fallbackError);
                    this.logger.info('Trying basic scan without any options...');
                    return this.ble.startScan([]).pipe(
                      catchError(basicError => {
                        this.logger.error('Basic BLE scan also failed:', basicError);
                        this.handleAndroidTVBluetoothError(error);
                        return empty();
                      })
                    );
                  })
                );
              } else {
                this.handleAndroidTVBluetoothError(error);
                return empty();
              }
            })
          );
        } else {
          this.logger.info('Not scanning for BLE devices');
          return empty();
        }
      })
    );
  }

  scan(): Observable<Peripheral> {
    return this.scanner.pipe(
      startWith(...this.devices.values()),
      distinct(device => device.id),
      tap(device => {
        this.logger.info('BLE device discovered:', {
          name: device.name,
          id: device.id,
          rssi: device.rssi,
          advertising: device.advertising
        });
      }),
      tap(device => {
        // Check if device name matches Control Unit pattern
        const isControlUnit = /Control.Unit/i.test(device.name || '');
        if (!isControlUnit && device.name) {
          this.logger.debug(`Device "${device.name}" does not match Control Unit pattern`);
        }
      }),
      filter(device => /Control.Unit/i.test(device.name || '')),
      tap(device => this.logger.info('✅ Found Control Unit device:', device)),
      tap(device => this.devices.set(device.id, device)),
      tap(_ => this.logger.debug('Total cached devices:', this.devices.size)),
      map(device => new BLEPeripheral(device, this.ble, this.logger))
    );
  }

  private checkBluetoothSupport() {
    // Log device information for debugging Android TV issues
    this.logger.info('Platform information:', {
      platforms: this.platform.platforms(),
      isAndroid: this.platform.is('android'),
      isCordova: this.platform.is('cordova'),
      userAgent: navigator.userAgent,
      androidVersion: this.getAndroidVersion()
    });

    // Check if this might be an Android TV
    const userAgent = navigator.userAgent.toLowerCase();
    const isAndroidTV = userAgent.includes('android') && 
                       (userAgent.includes('tv') || userAgent.includes('afts') || userAgent.includes('aftm'));
    
    if (isAndroidTV) {
      this.logger.warn('Android TV detected - Bluetooth functionality may be limited');
      this.logger.info('Consider using the External API for coin control instead of Bluetooth');
      
      // Test basic Bluetooth API availability
      this.testBluetoothCapabilities();
    }

    // Additional checks for Bluetooth availability
    if (typeof (window as any).bluetoothle !== 'undefined') {
      this.logger.info('BluetoothLE plugin detected');
    } else {
      this.logger.warn('BluetoothLE plugin not found - checking BLE plugin from @awesome-cordova-plugins');
    }
    
    // Check if the BLE plugin is available
    if (typeof (window as any).ble !== 'undefined') {
      this.logger.info('BLE plugin from @awesome-cordova-plugins detected');
    } else {
      this.logger.error('BLE plugin not found - Bluetooth functionality will not work');
      this.logger.error('Ensure cordova-plugin-ble-central is installed and platform built correctly');
    }
  }

  private async testBluetoothCapabilities() {
    try {
      // Test if we can check Bluetooth state
      const isEnabled = await this.ble.isEnabled();
      this.logger.info('Bluetooth state check successful:', isEnabled);
      
      // Android 11+ requires explicit location permission for BLE scanning
      const androidVersion = parseInt(this.getAndroidVersion().split('.')[0]);
      if (androidVersion >= 10) {
        this.logger.warn('Android 10+ detected - location permission is mandatory for BLE scanning');
        
        // Request location permission if available
        if (typeof (window as any).cordova?.plugins?.permissions !== 'undefined') {
          const permissions = (window as any).cordova.plugins.permissions;
          
          // Check location permission
          permissions.checkPermission('android.permission.ACCESS_FINE_LOCATION', 
            (status: any) => {
              this.logger.info('ACCESS_FINE_LOCATION permission status:', status.hasPermission);
              if (!status.hasPermission) {
                this.logger.error('Location permission not granted - BLE scanning will fail');
                this.logger.error('Please grant location permission in Android Settings');
                this.logger.error('Settings > Apps > OpenLap > Permissions > Location > Allow');
                
                // Try to request permission
                permissions.requestPermission('android.permission.ACCESS_FINE_LOCATION',
                  (result: any) => this.logger.info('Location permission request result:', result),
                  (error: any) => this.logger.error('Failed to request location permission:', error)
                );
              }
            },
            (error: any) => this.logger.error('Failed to check location permission:', error)
          );
        }
      }
      
      // Test if we can get location authorization status (required for BLE scanning)
      if (typeof (window as any).cordova?.plugins?.diagnostic !== 'undefined') {
        const diagnostic = (window as any).cordova.plugins.diagnostic;
        diagnostic.getLocationAuthorizationStatus(
          (status: string) => {
            this.logger.info('Location authorization status:', status);
            if (status !== 'GRANTED') {
              this.logger.warn('Location permission not granted - BLE scanning may fail');
            }
          },
          (error: any) => this.logger.warn('Could not check location authorization:', error)
        );
      }
    } catch (error) {
      this.logger.error('Bluetooth capability test failed:', error);
    }
  }

  private handleAndroidTVBluetoothError(error: any) {
    this.logger.error('BLE scanning error details:', error);
    
    // Common Android TV Bluetooth issues
    if (error.message) {
      if (error.message.includes('BLUETOOTH_ADMIN') || error.message.includes('BLUETOOTH_SCAN')) {
        this.logger.error('Android TV Bluetooth permission error detected');
        this.logger.error('Solutions:');
        this.logger.error('1. Grant Location permission to the app in Android TV Settings');
        this.logger.error('2. Enable Location Services system-wide');
        this.logger.error('3. Restart the app after granting permissions');
      } else if (error.message.includes('location') || error.message.includes('ACCESS_FINE_LOCATION')) {
        this.logger.error('Location permission required for BLE scanning on Android TV');
        this.logger.error('Go to: Settings > Apps > OpenLap > Permissions > Location > Allow');
      } else if (error.message.includes('disabled')) {
        this.logger.error('Bluetooth appears to be disabled');
        this.logger.error('Enable Bluetooth in: Settings > Remotes & Accessories > Bluetooth');
      } else {
        this.logger.error('Unknown BLE error on Android TV:', error.message);
      }
    }
    
    this.logger.warn('Consider using the External API instead of Bluetooth for this Android TV device');
  }

  private getAndroidVersion(): string {
    const userAgent = navigator.userAgent;
    const match = userAgent.match(/Android (\d+(?:\.\d+)*)/i);
    return match ? match[1] : 'Unknown';
  }
}
