import { Component, OnDestroy, OnInit } from '@angular/core';
import { ActivatedRoute } from '@angular/router';

import { PopoverController, Platform } from '@ionic/angular';

import { TranslateService } from '@ngx-translate/core';

import { Observable, Subscription, from, of, merge, forkJoin } from 'rxjs';
import { combineLatest } from 'rxjs';
import { distinctUntilChanged, filter, map, mergeMap, pairwise, share, skipWhile, startWith, switchMap, take, withLatestFrom } from 'rxjs/operators';

import { AppSettings, Options, RaceOptions } from '../app-settings';
import { ControlUnit } from '../carrera';
import { AppService, ControlUnitService, LoggingService, SpeechService, ExternalApiService, I18nAlertService, TuningSyncService } from '../services';
import { CarSyncService } from '../services/car-sync.service';
import { WebDisplayService } from '../services/web-display.service';

import { LeaderboardItem } from './leaderboard';
import { RmsMenu } from './rms.menu';
import { Session } from './session';

const compare = {
  'position': (lhs: LeaderboardItem, rhs: LeaderboardItem) => {
    return lhs.position - rhs.position;
  },
  'number':  (lhs: LeaderboardItem, rhs: LeaderboardItem) => {
    return lhs.id - rhs.id;
  }
};

@Component({
  templateUrl: 'rms.page.html',
})
export class RmsPage implements OnDestroy, OnInit {

  mode: 'practice' | 'qualifying' | 'race';

  session: Session;

  options: Options;
  
  pitlane: Observable<boolean>;
  sectors: Observable<boolean>;
  items: Observable<LeaderboardItem[]>;

  lapcount: Observable<{count: number, total: number}>;

  start: Observable<number>;

  orientation: Observable<string>;

  legacyAndroid: Promise<boolean>;

  apiConnected: Observable<boolean>;

  canStartRace: boolean = true; // Indique si on peut démarrer la course (assez de participants)

  private subscriptions: Subscription;

  private backButtonSubscription: Subscription;

  private dataSubscription: Subscription;

  private subscription = new Subscription();

  constructor(public cu: ControlUnitService, private app: AppService,
    private logger: LoggingService, private settings: AppSettings, private speech: SpeechService,
    private popover: PopoverController, private translate: TranslateService, route: ActivatedRoute,
    private carSync: CarSyncService, private externalApi: ExternalApiService,
    private webDisplay: WebDisplayService, private alert: I18nAlertService, private tuningSync: TuningSyncService)
  {
    const mode = route.snapshot.paramMap.get('mode');
    switch (mode) {
    case 'practice':
    case 'qualifying':
    case 'race':
      this.mode = mode;
      break;
    default:
      this.mode = 'practice';
    }
        
    const cuMode = cu.pipe(
      filter(cu => !!cu),
      mergeMap(cu => cu.getMode()), 
      startWith(0),
      distinctUntilChanged()
    );

    // TODO: pitlane flag is actually (cuMode & 0x04), rename to fuelMode?
    this.pitlane = cuMode.pipe(
      map(value => (value & 0x03) != 0)
    );

    this.sectors = settings.getOptions().pipe(
      map(options => options.sectors)
    );

    this.start = cu.pipe(
      filter(cu => !!cu),
      mergeMap(cu => cu.getStart()),
      distinctUntilChanged()
    );

    this.orientation = app.orientation;  // for showing/hiding additional icons

    // Observable pour le statut de connexion à l'API externe
    this.apiConnected = this.externalApi.isConnected$;

    // flag for older Android versions that require Location services and support USB OTG connections
    this.legacyAndroid = app.isAndroid() && app.isCordova() ?
      app.getDeviceInfo().then(device => (device.version < '12')) :
      Promise.resolve(false);
    }

  ngOnInit() {
    this.subscription.add(combineLatest([this.cu, this.getRaceOptions(this.mode)]).subscribe(([cu, options]) => {
      if (cu && options) {
        this.session = this.startSession(cu, options);

        // Si on est en mode course et que l'API externe est activée,
        // reset toutes les voitures quand le CU devient prêt
        if (this.mode === 'race' && this.externalApi.isEnabled()) {
          this.carSync.resetAllActiveCars().subscribe({
            next: (response) => {
              this.logger.info('All cars reset to normal state when CU ready:', response);
            },
            error: (error) => {
              this.logger.error('Failed to reset cars when CU ready:', error);
            }
          });
        }
      } else {
        this.session = null;
      }
    }));
    this.subscription.add(this.settings.getOptions().subscribe(options => {
      this.options = options;
    }));

    // Surveiller les changements de l'External API pour mettre à jour canStartRace
    if (this.externalApi.isEnabled()) {
      this.subscription.add(
        this.externalApi.cars$.subscribe(() => {
          this.updateCanStartRace();
        })
      );
    }
  }

  private updateCanStartRace() {
    const unpaidMask = this.calculateUnpaidCarsMask();
    const paidCarsCount = this.countPaidCars(unpaidMask);
    this.canStartRace = paidCarsCount >= 2;
  }

  startSession(cu: ControlUnit, options: RaceOptions) {
    const session = new Session(cu, options, this.carSync);

    // Garder la session pour RMS (affichage natif)
    this.session = session;

    // WebDisplay sera reconnecté après que this.items soit configuré

    this.lapcount = session.currentLap.pipe(
      map(lap => {
        return {
          count: lap,
          total: options.laps
        };
      }),
      startWith({
          count: 0,
          total: options.laps
      })
    );

    const drivers = this.settings.getDrivers().pipe(switchMap(drivers => {
      const observables = drivers.map((obj, index) => {
        const code = obj.code || '#' + (index + 1);
        if (obj.name) {
          return of({name: obj.name, code: code, color: obj.color, brake: obj.brake, speed: obj.speed, carImage: obj.carImage});
        } else {
          return this.getTranslations('Driver {{number}}', {number: index + 1}).pipe(map((name: string) => {
            return {name: name, code: code, color: obj.color, brake: obj.brake, speed: obj.speed, carImage: obj.carImage}
          }));
        }
      });
      return combineLatest(observables);
    }));

    const best = [Infinity, Infinity, Infinity, Infinity];
    const events = merge(
      session.grid.pipe(
        map(obs => obs.pipe(pairwise())),
        mergeMap(obs => obs),
        mergeMap(([prev, curr]) => {
          const events = [];
          curr.best.forEach((time, index) => {
            if ((time || Infinity) < best[index]) {
              best[index] = time;
              if (curr.laps >= 3) {
                events.push([index ? 'bests' + index : 'bestlap', curr.id]);
              }
            }
          });
          if (!curr.finished && curr.time) {
            if (curr.fuel < prev.fuel) {
              events.push(['fuel' + curr.fuel, curr.id]);
            }
            if (curr.pit && !prev.pit) {
              events.push(['pitenter', curr.id]);
            }
            if (!curr.pit && prev.pit) {
              events.push(['pitexit', curr.id]);
            }
          }
          return from(events);
        }),
      ),
      session.ranking.pipe(
        filter(items => items.length > 0 && options.mode == 'race'),
        map(items => items.map(e => {return {id: e.id, finished: e.finished}})),
        pairwise(),
        filter(([_, curr]) => curr[0].finished),
        mergeMap(([prev, curr]) => {
          const events = [];
          if (!prev[0].finished && curr[0].finished) {
            if (curr.length > 1) {
              events.push(['finished1st', curr[0].id]);
            } else {
              events.push(['finished', null]);
            }
          }
          if (curr.length >= 2 && !prev[1]?.finished && curr[1].finished) {
            events.push(['finished2nd', curr[1].id]);
          }
          if (curr.length >= 3 && !prev[2]?.finished && curr[2].finished) {
            events.push(['finished3rd', curr[2].id]);
          }
          return from(events);
        }),
      ),
      session.ranking.pipe(
        filter(items => items.length != 0 && options.mode == 'race'),
        map(items => items[0]),
        pairwise(),
        filter(([prev, curr]) => prev.id != curr.id),
        map(([_, curr]) => ['newleader', curr.id])
      ),
      session.timer.pipe(
        filter(time => {
          return options.time >= 120_000 && time <= 60_000 && !session.finished.value;
        }),
        take(1),
        map(() => ['oneminute', null])
      ),
      session.timer.pipe(
        map(time => [time, session.finished.value]),
        pairwise(),
        map(([prev, curr]) => [curr[0], prev[1]]),
        filter(([time, fin]) => {
          return time == 0 && !fin;
        }),
        take(1),
        map(() => ['timeout', null])
      ),
      session.yellowFlag.pipe(
        distinctUntilChanged(),
        skipWhile(value => !value),
        map(value => [value ? 'yellowflag' : 'greenflag', null])
      ),
      session.allFinished.pipe(
        filter(v => v),
        take(1),
        map(() => ['alldone', null])  // TODO: add notification, qualifying vs. race?
      ),
      this.lapcount.pipe(
        filter(laps => {
          return options.laps >= 10 && laps.count === options.laps - 4 && !session.finished.value;
        }),
        take(1),
        map(() => ['fivelaps', null])  // TODO: threelaps, too?
      ),
      this.lapcount.pipe(
        filter(laps => {
          return options.laps && laps.count === options.laps && !session.finished.value;
        }),
        take(1),
        map(() => ['finallap', null])
      ),
      this.start.pipe(
        distinctUntilChanged(),
        filter(value => value === 9),
        map(() => ['falsestart', null])
      )
    ).pipe(
      withLatestFrom(drivers),
      map(([[event, id], drivers]) => {
        return <[string, any]>[event, id !== null ? drivers[id] : null];
      })
    );

    const order = this.settings.getOptions().pipe(
      map(options => options.fixedorder ? 'number' : 'position')
    );
    const gridpos = [];
    const pitfuel = [];
    this.items = combineLatest([session.ranking, drivers, order, this.externalApi.cars$, this.externalApi.coinAcceptors$]).pipe(
      map(([ranks, drivers, order, apiCars, coinAcceptors]) => {
        const items = ranks.map((item, index) => {
          if (options.mode == 'race' && gridpos[item.id] === undefined && item.time !== undefined) {
            gridpos[item.id] = index;
          }
          if (!item.pit || item.fuel < pitfuel[item.id]) {
            pitfuel[item.id] = item.fuel;
          }
          // Obtenir les données en temps réel depuis l'API
          const carInfo = apiCars.find(car => car.car_id === item.id + 1); // item.id est 0-based, API car_id est 1-based
          const coinInfo = coinAcceptors.find(coin => coin.id === item.id + 1);

          // Utiliser le compteur persistant (survit aux resets du contrôleur)
          const creditCounter = this.externalApi.getCreditCounter(item.id + 1);
          const hasPaid = creditCounter > 0;

          return Object.assign({}, item, {
            position: index,
            driver: drivers[item.id],
            gridpos: gridpos[item.id],
            refuel: item.pit && item.fuel > pitfuel[item.id],
            throttle: carInfo ? carInfo.accelerator_percent : 0,
            buttonPressed: carInfo ? carInfo.button_pressed : false,
            hasPaid: hasPaid,
            coinValue: creditCounter,
            waitingForPayment: !hasPaid && carInfo && carInfo.active,
            blocked: carInfo ? carInfo.blocked : false,
            manuallyUnblocked: carInfo ? carInfo.manually_unblocked : false,
            manuallyBlocked: carInfo ? carInfo.manually_blocked : false,
            brakeWear: drivers[item.id]?.brake !== undefined ? drivers[item.id].brake : 15,
            speed: drivers[item.id]?.speed !== undefined ? drivers[item.id].speed : 10
          });
        });
        items.sort(compare[order || 'position']);
        return items;
      }),
      share()
    );

    // WebDisplay sera connecté par ionViewDidEnter() après la navigation
    this.logger.info('🔄 New session created - WebDisplay will connect via ionViewDidEnter()');

    if (this.subscriptions) {
      this.subscriptions.unsubscribe();
    }
    this.subscriptions = events.pipe(withLatestFrom(
      this.settings.getOptions(),
      this.settings.getNotifications(),
      this.getTranslations('notifications')
    )).subscribe(([[event, driver], options, notifications, translations]) => {
      this.logger.debug('Race event: ' + event, driver);
      if (options.speech && notifications[event] && notifications[event].enabled) {
        let message = notifications[event].message || translations[event];
        if (driver && driver.name) {
          this.speech.speak(driver.name + ': ' + message);
        } else {
          this.speech.speak(message);
        }
      }
    });

    this.subscriptions.add(
      this.lapcount.subscribe(
        laps => {
          cu.setLap(laps.count);
        },
        error => {
          this.logger.error('Lap counter error:', error);
        },
        () => {
          this.logger.info('Lap counter finished');
        }
      )
    );

    this.subscriptions.add(
      events.pipe(
        filter(([event]) => event == 'alldone'),
        withLatestFrom(this.getRaceOptions(options.mode))
      ).subscribe(([[event], options]) => {
        if (options.stopfin) {
          cu.toggleStart();  // TODO: read state?
        }
      })
    );

    // Appliquer les paramètres de difficulté dès la création de la session (avant les feux)
    if (options.difficultyLevel) {
      this.logger.info('🎮 Applying difficulty settings immediately after session creation');
      this.applyDifficultySettings(cu, options.difficultyLevel);
    }

    if (options.mode != 'practice') {
      const start = cu.getStart();

      // En mode débutant, remettre à l'état normal uniquement les voitures participantes quand les feux s'éteignent
      if (options.difficultyLevel === 'beginner' && this.carSync) {
        start.pipe(
          pairwise(),
          filter(([prev, curr]) => prev !== 0 && curr === 0),
          take(1)
        ).subscribe(() => {
          this.logger.info('🟢 Beginner mode: resetting participating cars to normal - race started!');

          // Utiliser le masque pour identifier les voitures qui ont payé
          const unpaidMask = this.calculateUnpaidCarsMask();
          this.logger.info('Unpaid mask:', unpaidMask.toString(2).padStart(8, '0'));

          const activeCars = this.carSync.getActiveCars();
          // Débloquer les voitures actives qui ont payé (bit à 0 dans le masque)
          const participatingCars = activeCars.filter(car => {
            const carMask = 1 << (car.car_id - 1); // car_id est 1-based
            const isPaid = (unpaidMask & carMask) === 0;
            this.logger.info(`Car ${car.car_id}: mask bit=${(unpaidMask & carMask) !== 0}, isPaid=${isPaid}`);
            return isPaid;
          });

          this.logger.info(`Found ${participatingCars.length} participating cars to reset`);

          if (participatingCars.length > 0) {
            // Utiliser le nouveau endpoint batch pour débloquer toutes les voitures en une seule requête
            const carsToReset = participatingCars.map(car => ({
              car_id: car.car_id,
              reset_to_normal: true
            }));

            this.externalApi.blockCars(carsToReset).subscribe({
              next: (response) => {
                this.logger.info(`✅ Participating cars reset to normal (${response.success_count}/${response.total}) - race can begin`);
              },
              error: (error) => {
                this.logger.error('❌ Error resetting cars:', error);
              }
            });
          } else {
            this.logger.info('⚠️ No participating cars to reset!');
          }
        });
      }

      // Appliquer le masque quand la séquence de feux démarre (transition 1 -> 2)
      start.pipe(
        pairwise(),
        filter(([prev, curr]) => prev === 1 && curr === 2),
        take(1)
      ).subscribe(() => {
        this.logger.info('Light sequence starting (1->2) - applying payment mask');
        const unpaidMask = this.calculateUnpaidCarsMask();

        // Appliquer le masque des voitures non payées
        if (unpaidMask > 0) {
          this.logger.info('Masking unpaid cars:', unpaidMask.toString(2).padStart(8, '0'));
          session.applyUnpaidMask(unpaidMask);
        } else {
          this.logger.info('All cars paid or API disabled - no masking');
        }
      });

      start.pipe(take(1)).toPromise().then(value => {
        this.logger.info('Initial start value:', value);
        if (value === 0) {
          // En mode débutant, bloquer toutes les voitures AVANT de démarrer la séquence
          if (options.difficultyLevel === 'beginner' && this.carSync) {
            this.logger.info('🔴 Beginner mode: blocking all cars BEFORE countdown start');
            const activeCars = this.carSync.getActiveCars();
            this.logger.info(`Found ${activeCars.length} active cars to block`);
            const blockRequests = activeCars.map(car =>
              this.externalApi.blockCar(car.car_id, true)
            );

            if (blockRequests.length > 0) {
              forkJoin(blockRequests).subscribe({
                next: (results) => {
                  this.logger.info('✅ All cars blocked, now starting countdown');
                  cu.toggleStart();
                },
                error: (error) => {
                  this.logger.error('❌ Error blocking cars:', error);
                  cu.toggleStart(); // Lancer quand même le décompte en cas d'erreur
                }
              });
            } else {
              cu.toggleStart();
            }
          } else {
            cu.toggleStart();
          }
        }
        // wait until startlight goes off; TODO: subscribe/unsubscribe?
        cu.getStart().pipe(pairwise(),filter(([prev, curr]) => {
          return prev != 0 && curr == 0;
        }),take(1),).toPromise().then(() => {
          this.logger.info('Start ' + options.mode + ' mode');
          session.start();
        });
      });

    }

    return session;
  }

  ngOnDestroy() {
    this.subscription.unsubscribe();
    if (this.subscriptions) {
      this.subscriptions.unsubscribe();
    }
    if (this.dataSubscription) {
      this.dataSubscription.unsubscribe();
    }
    // Déconnecter le service d'affichage web
    this.webDisplay.disconnectSession();
  }

  ionViewWillEnter() {
    this.logger.info('🚪 ionViewWillEnter called');
  }

  ionViewDidEnter(){
    this.logger.info('🚪 ionViewDidEnter called');
    
    this.backButtonSubscription = this.app.backButton.subscribe(() => {
      // TODO: confirm or press back button twice?
      if (this.cu.value) {
        this.cu.value.disconnect().catch(error => {
          this.logger.error('Error disconnecting from CU:', error);
        }).then(() => {
          this.app.exit();
        });
      } else {
        this.app.exit();
      }
    });
    
    // Connecter WebDisplay SEULEMENT quand l'observable items émet sa première valeur
    if (this.session && this.items) {
      this.logger.info('🎯 Session and items available, waiting for first emission...');
      
      // S'abonner temporairement pour attendre la première émission
      const testSub = this.items.subscribe(items => {
        this.logger.info('✅ Items observable is emitting! Connecting WebDisplay now.', {
          itemsCount: items?.length,
          mode: this.session?.options?.mode
        });
        
        // Connecter WebDisplay maintenant qu'on sait que l'observable fonctionne
        this.webDisplay.connectToRmsData(this, this.session.options);
        
        // Se désabonner de ce test
        testSub.unsubscribe();
      });
      
    } else {
      this.logger.warn('⚠️ Session or items not available:', {
        hasSession: !!this.session,
        hasItems: !!this.items
      });
    }
  }

  ionViewWillLeave(){
    this.backButtonSubscription.unsubscribe();
  }

  restartSession() {
    if (this.session) {
      // Déconnecter le service d'affichage web avant de redémarrer
      this.webDisplay.disconnectSession();

      // Créer une nouvelle session
      this.session = this.startSession(this.session.cu, this.session.options);

      // Reconnecter le service d'affichage web avec la nouvelle session
      this.webDisplay.connectToRmsData(this, this.session.options);
    }
  }

  cancelSession() {
    if (this.session) {
      this.session.stop();
    }
  }

  private getRaceOptions(mode: string) {
    switch (mode) {
      case 'race':
        return this.settings.getRaceSettings();
      case 'qualifying':
        return this.settings.getQualifyingSettings();
      default:
        return of(new RaceOptions('practice'));
    }
  }

  toggleSpeech() {
    if (this.options) {
      this.settings.setOptions(Object.assign({}, this.options, {speech: !this.options.speech}));
    }
  }

  toggleYellowFlag() {
    if (this.session) {
      this.session.toggleYellowFlag();
    }
  }

  onStartClick(triggerStart: () => void) {
    this.logger.info('🎬 Start button clicked!');

    // En mode débutant, bloquer toutes les voitures AVANT de démarrer le CU
    if (this.session?.options?.difficultyLevel === 'beginner' && this.carSync) {
      // Récupérer l'état actuel des feux pour le log
      this.cu.pipe(take(1)).subscribe(cu => {
        cu.getStart().pipe(take(1)).subscribe(startValue => {
          this.logger.info(`🔴 Beginner mode: blocking all cars BEFORE starting countdown (current start value: ${startValue})`);

          const activeCars = this.carSync.getActiveCars();
          this.logger.info(`Found ${activeCars.length} active cars to block`);

          if (activeCars.length > 0) {
            // Utiliser le nouveau endpoint batch pour bloquer toutes les voitures en une seule requête
            const carsToBlock = activeCars.map(car => ({
              car_id: car.car_id,
              blocked: true
            }));

            this.externalApi.blockCars(carsToBlock).subscribe({
              next: (response) => {
                this.logger.info(`✅ All cars blocked (${response.success_count}/${response.total}), NOW triggering countdown start`);
                triggerStart(); // Lancer le décompte APRÈS le blocage
              },
              error: (error) => {
                this.logger.error('❌ Error blocking cars, starting countdown anyway');
                triggerStart(); // Lancer quand même en cas d'erreur
              }
            });
          } else {
            this.logger.info('No cars to block, starting countdown');
            triggerStart();
          }
        });
      });
    } else {
      // Mode normal, démarrer immédiatement
      triggerStart();
    }
  }

  showMenu(event: Event) {
    return this.popover.create({
      component: RmsMenu,
      componentProps: {
        mode: this.mode,
        active: this.session && !this.session.finished.value && this.mode != 'practice',
        restart: () => this.restartSession(),
        cancel:  () => this.cancelSession()
      }, 
      event: event
    }).then(menu => {
      menu.present();
    });
  }

  // see https://github.com/ngx-translate/core/issues/330
  private getTranslations(key: string, params?: Object) {
    return this.translate.stream(key, params);
  }

  /**
   * Calculer le masque des voitures qui n'ont pas payé
   * Retourne un masque de bits pour exclure les voitures non payées
   * Si l'External API n'est pas activée ou non connectée, retourne 0 (aucun masque)
   */
  private calculateUnpaidCarsMask(): number {
    // Si l'External API n'est pas activée, ne pas masquer les voitures
    if (!this.externalApi.isEnabled()) {
      this.logger.info('External API disabled - no payment masking applied');
      return 0;
    }

    // Vérifier si l'API est connectée (valeurs initiales capturées)
    let isConnected = false;
    this.externalApi.isConnected$.pipe(take(1)).subscribe(connected => {
      isConnected = connected;
    });

    if (!isConnected) {
      this.logger.info('External API not connected yet - no payment masking applied');
      return 0;
    }

    let mask = 0;

    // Pour chaque contrôleur (0-5, car IDs 1-6)
    for (let controllerId = 0; controllerId < 6; controllerId++) {
      const carId = controllerId + 1; // API utilise des IDs 1-based
      const creditCounter = this.externalApi.getCreditCounter(carId);

      // Si le joueur n'a pas payé (compteur <= 0), masquer ce contrôleur
      if (creditCounter <= 0) {
        mask |= (1 << controllerId);
      }
    }

    return mask;
  }

  /**
   * Compter le nombre de voitures qui ont payé
   * @param unpaidMask Masque des voitures non payées
   * @returns Nombre de voitures payantes
   */
  private countPaidCars(unpaidMask: number): number {
    // Si l'External API n'est pas activée, toutes les voitures peuvent participer
    if (!this.externalApi.isEnabled()) {
      return 6; // On considère que toutes les voitures peuvent participer
    }

    let paidCount = 0;
    for (let controllerId = 0; controllerId < 6; controllerId++) {
      // Si le bit n'est PAS dans le masque unpaid, la voiture a payé
      if ((unpaidMask & (1 << controllerId)) === 0) {
        paidCount++;
      }
    }

    return paidCount;
  }

  /**
   * Appliquer les paramètres de difficulté à toutes les voitures
   * @param cu Control Unit
   * @param level Niveau de difficulté
   */
  private applyDifficultySettings(cu: ControlUnit, level: 'beginner' | 'intermediate' | 'expert'): void {
    let speedValue: number;
    let brakeValue: number;

    switch (level) {
      case 'beginner':
        speedValue = 4;  // 40% (4/10)
        brakeValue = 15; // 100% (15/15)
        this.logger.info('Applying BEGINNER difficulty: Speed 40%, Brake 100%');
        break;
      case 'intermediate':
        speedValue = 7;  // 70% (7/10)
        brakeValue = 10; // ~70% (10/15)
        this.logger.info('Applying INTERMEDIATE difficulty: Speed 70%, Brake 70%');
        break;
      case 'expert':
        speedValue = 10; // 100% (10/10)
        brakeValue = 7;  // ~50% (7/15)
        this.logger.info('Applying EXPERT difficulty: Speed 100%, Brake 50%');
        break;
      default:
        this.logger.warn('Unknown difficulty level:', level);
        return;
    }

    // Appliquer immédiatement les paramètres au Control Unit
    for (let carId = 0; carId < 6; carId++) {
      cu.setSpeed(carId, speedValue);
      cu.setBrake(carId, brakeValue);
      this.logger.info(`📤 Sent to CU - Car ${carId + 1}: Speed=${speedValue}, Brake=${brakeValue}`);
    }

    // Sauvegarder les valeurs de freins et vitesse dans les paramètres des drivers pour l'affichage
    this.settings.getDrivers().pipe(take(1)).subscribe(async (drivers) => {
      this.logger.info('🔍 Current drivers values:', drivers.map(d => ({ brake: d.brake, speed: d.speed })));

      const updatedDrivers = drivers.map(driver => ({
        ...driver,
        brake: brakeValue,
        speed: speedValue
      }));

      this.logger.info('🔄 Updating drivers - brake:', brakeValue, 'speed:', speedValue);
      await this.settings.setDrivers(updatedDrivers);
      this.logger.info('✅ Driver settings saved');

      // Vérifier que la sauvegarde a fonctionné
      this.settings.getDrivers().pipe(take(1)).subscribe(newDrivers => {
        this.logger.info('🔍 Verification - New values:', newDrivers.map(d => ({ brake: d.brake, speed: d.speed })));
      });
    });
  }
}
