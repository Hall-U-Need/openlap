import { EMPTY, BehaviorSubject, Observable, interval, merge } from 'rxjs';
import { combineLatestWith, distinctUntilChanged, filter, groupBy, map, mergeMap, publishReplay, refCount, scan, share, startWith, tap, withLatestFrom, switchMap, combineLatest } from 'rxjs/operators';

import { RaceOptions } from '../app-settings';
import { ControlUnit } from '../carrera';
import { CarSyncService } from '../services/car-sync.service';

const TIMER_INTERVAL = 500;

function createMask(first: number, last: number) {
  let mask = 0;
  while (first !== last) {
    mask |= (1 << first);
    ++first;
  }
  return mask;
}

export interface Entry {
  id: number
  time: number;
  laps: number;
  last: number[];
  best: number[];
  times: number[][];
  fuel?: number;
  pit?: boolean;
  pits?: number;
  sector: number;
  finished?: boolean;
}

function numCompare(lhs: number, rhs: number) {
  const r = lhs - rhs;
  if (!isNaN(r)) {
    return r;
  } else if (isNaN(lhs)) {
    return isNaN(rhs) ? 0 : 1;
  } else {
    return -1;
  }
}

function timeCompare(lhs: Entry, rhs: Entry) {
  return (lhs.best[0] || Infinity) - (rhs.best[0] || Infinity);
}

function raceCompare(lhs: Entry, rhs: Entry) {
  return (rhs.laps - lhs.laps) || numCompare(lhs.time, rhs.time) || (lhs.id - rhs.id);
}

const COMPARE = {
  'practice': timeCompare,
  'qualifying': timeCompare,
  'race': raceCompare
}

export class Session {
  grid: Observable<Observable<Entry>>;
  ranking: Observable<Entry[]>;
  currentLap: Observable<number>;
  finished = new BehaviorSubject(false);
  yellowFlag = new BehaviorSubject(false);
  allFinished: Observable<boolean>;
  timer: Observable<number>;
  started = false;
  stopped = false;
  manuallyStopped = false; // Arrêt manuel par l'utilisateur

  private mask: number;
  private active = 0;

  private realMask: number = null;
  private coinsConsumed = false; // Pour ne consommer qu'une seule fois
  private autoBlockedCars = new Set<number>(); // Track les voitures bloquées automatiquement à la fin

  // TODO: move settings handling/combine to race-control!
  constructor(public cu: ControlUnit, public options: RaceOptions, private carSync?: CarSyncService) {
    const compare = COMPARE[options.mode];

    const reset = merge(
      cu.getStart().pipe(distinctUntilChanged(),filter(start => start != 0),),
      cu.getState().pipe(filter(state => state == 'connected'),)
    ).pipe(map(value => {
      cu.setMask(this.mask);
    }));
    // create monotonic timer
    type TimerType = [number, number, number];
    const timer = cu.getTimer().pipe(
      filter(([id]) => {
        return !(this.mask & (1 << id));
      }),
      scan<TimerType, TimerType[]>(([_, [prev, offset, then]], [id, time, group]) => {
        // TODO: combine with reset?
        const now = Date.now();
        if (time < prev) {
          offset = ((now - then + prev) || 0) - time;
        }
        return [[id, time + offset, group], [time, offset, now]];
      }, [[Infinity, 0, NaN], [Infinity, 0, NaN]]),
      map(([t]: TimerType[]) => t)
    );
    const fuel = cu.getFuel();
    const pit = cu.getPit();

    this.mask = (options.auto ? 0 : 1 << 6) | (options.pace ? 0 : 1 << 7);

    if (options.drivers) {
      this.mask |= createMask(options.drivers, 6);
      this.grid = this.createGrid(timer, fuel, pit, ~this.mask & 0xff);
    } else {
      this.grid = this.createGrid(timer, fuel, pit);
    }

    this.ranking = reset.pipe(
      startWith(null),
      combineLatestWith(this.grid),
      map(([_reset, grid]) => {
        return grid;  // for reset side effects only...
      }),
      /*mergeAll(),*/
      mergeMap(val => val),
      scan((grid, event) => {
        const newgrid = [...grid];
        newgrid[event.id] = event;
        return newgrid;
      }, []),
      map((cars: Array<Entry>) => {
        const ranks = cars.filter(car => {
          // Filtrer les voitures inexistantes
          if (!car) return false;
          // Filtrer les voitures masquées par le paiement
          if (this.isCarMaskedByPayment(car.id)) {
            console.log('Filtering out car', car.id, 'because unpaid (mask:', this.unpaidMask.toString(2).padStart(8, '0'), ')');
            return false;
          }
          return true;
        });
        ranks.sort(compare);
        return ranks;
      })
    );

    this.currentLap = this.grid.pipe(
      /*mergeAll(),*/
      mergeMap(val => val),
      scan<Entry, number>((current, event) => {
        if (current > event.laps) {
          return current;
        } else if (this.finished.value || isNaN(event.time)) {
          return event.laps;
        } else {
          return event.laps + 1;
        }
      }, 0),
      startWith(0),
      publishReplay(1),
      refCount(),
      distinctUntilChanged()
    );

    this.allFinished = this.ranking.pipe(
      combineLatestWith(this.finished),
      map(([cars, fini]) => {
        return fini && cars.every(e => e.finished);
      }),
      startWith(false),
      publishReplay(1),
      refCount(),
      distinctUntilChanged()
    );

    if (options.time) {
      this.timer = interval(TIMER_INTERVAL).pipe(
        withLatestFrom(
          cu.getStart(),
          cu.getState()
        ),
        filter(([_, start, state]) => {
          return this.started && (!this.options.pause || (start == 0 && state == 'connected'));
        }),
        scan<any, number>((time, _) => {
          return Math.max(0, time - TIMER_INTERVAL);
        }, options.time),
        tap(time => {
          if (time == 0) {
            this.stopped = true;
            this.finish();
          }
        }),
        share(),
        startWith(options.time)
      );
    } else {
      this.timer = EMPTY;
    }

    this.cu.setMask(this.mask);
    this.cu.clearPosition();
    this.cu.reset();
  }

  start() {
    this.started = true;
  }

  stop() {
    this.stopped = true;
    this.manuallyStopped = true; // Marquer comme arrêt manuel
    this.finish();
  }

  toggleYellowFlag() {
    const value = this.yellowFlag.value;
    if (this.yellowFlag.value) {
      this.mask = this.realMask;
      this.realMask = null;
    } else {
      this.realMask = this.mask;
      this.mask = 0xff;
    }
    this.cu.setMask(this.mask);
    this.yellowFlag.next(!value);
  }

  private unpaidMask = 0;

  /**
   * Appliquer le masque des voitures non payées
   * À appeler au début de la séquence de feux
   */
  applyUnpaidMask(unpaidMask: number) {
    this.unpaidMask = unpaidMask;
    this.mask |= unpaidMask;
    this.cu.setMask(this.mask);
    console.log('Unpaid mask applied to session:', this.mask.toString(2).padStart(8, '0'), 'binary =', this.mask);
    console.log('Unpaid mask stored:', this.unpaidMask.toString(2).padStart(8, '0'));
  }

  /**
   * Vérifier si une voiture est masquée par le masque de paiement
   */
  isCarMaskedByPayment(carId: number): boolean {
    return (this.unpaidMask & (1 << carId)) !== 0;
  }

  private createGrid(
    timer: Observable<[number, number, number]>,
    fuel: Observable<ArrayLike<number>>,
    pits: Observable<number>,
    mask = 0
  ) {
    const init = new Array<[number, number, number]>();
    for (let i = 0; mask; ++i) {
      if (mask & 1) {
        init.push([i, NaN, 0]);
      }
      mask >>>= 1;
    }

    // Ajouter les voitures détectées par l'API externe si le service est disponible
    // Les voitures apparaissent dans le leaderboard mais ne peuvent enregistrer des temps que si elles ont payé
    if (this.carSync) {
      const activeCars = this.carSync.getActiveCars();
      activeCars.forEach(car => {
        const arrayIndex = car.car_id - 1; // car_id est 1-based, array 0-based
        if (arrayIndex >= 0 && arrayIndex < 8 && !(mask & (1 << arrayIndex))) {
          // Ajouter toutes les voitures actives pour qu'elles apparaissent dans le leaderboard
          init.push([arrayIndex, NaN, 0]);
          this.active |= (1 << arrayIndex);
        }
      });
    }

    // Créer un observable qui surveille les changements des voitures actives
    const dynamicCarEntries = this.carSync ? 
      this.carSync.cars$.pipe(
        distinctUntilChanged((prev, curr) => JSON.stringify(prev) === JSON.stringify(curr)),
        map(apiCars => {
          const newEntries: [number, number, number][] = [];
          apiCars.forEach(car => {
            const arrayIndex = car.car_id - 1;
            if (arrayIndex >= 0 && arrayIndex < 8 && car.active) {
              // Vérifier si cette voiture n'est pas déjà active
              if (!(this.active & (1 << arrayIndex))) {
                newEntries.push([arrayIndex, NaN, 0]);
                this.active |= (1 << arrayIndex);
              }
            }
          });
          return newEntries;
        }),
        filter(newEntries => newEntries.length > 0), // Seulement émettre s'il y a de nouvelles voitures
        mergeMap(newEntries => newEntries)
      ) : EMPTY;

    return merge(
      timer.pipe(startWith(...init)),
      dynamicCarEntries
    ).pipe(groupBy(([id]) => id), map(group => {
      type TimeInfo = [number[][], number[], number[], boolean];
      this.active |= (1 << group.key);

      const times = group.pipe(scan(([times, last, best, finished]: TimeInfo, [id, time, sensor]: [number, number, number]) => {
        const tail = times[times.length - 1] || [];
        // Vérifier si la voiture a payé avant d'enregistrer les temps
        const canRecordTime = !this.carSync || this.carSync.hasCarPaid(id + 1); // id est 0-based, car_id est 1-based
        if (sensor && time > (tail.length >= sensor ? tail[sensor - 1] : -Infinity) + this.options.minLapTime && canRecordTime) {
          if (sensor === 1) {
            times.push([time]);
            last[0] = time - tail[0];
            best[0] = Math.min(last[0], best[0] || Infinity);
            if (tail.length > 1) {
              last[tail.length] = time - tail[tail.length - 1];
              best[tail.length] = Math.min(last[tail.length], best[tail.length] || Infinity);
            }
            if (!finished && this.isFinished(times.length - 1)) {
              this.finish(id);
              finished = true;
            }
          } else {
            const index = sensor - 1;
            tail[index] = time;
            last[index] = time - tail[index - 1];
            best[index] = Math.min(last[index], best[index] || Infinity);
          }
        }
        return <TimeInfo>[times, last, best, finished];
      }, <TimeInfo>[[], [], [], false]));

      type PitInfo = [number, boolean];
      return times.pipe(
        combineLatestWith(
          pits.pipe(
            map(mask => ((mask & ~this.mask) & (1 << group.key)) != 0),
            distinctUntilChanged(),
            scan<boolean, PitInfo>(([count], inpit) => {
              return [inpit ? count + 1 : count, inpit];
            }, [0, false])
          ),
          fuel.pipe(
            map(fuel => fuel[group.key]),
            distinctUntilChanged()
          )
        ),
        map(([[times, last, best, finished], [pits, pit], fuel]: [TimeInfo, [number, boolean], number]) => {
          const laps = times.length ? times.length - 1 : 0;
          const curr = times[times.length - 1] || [];
          const prev = times[times.length - 2] || [];
          return {
            id: group.key,
            time: curr[0],
            laps: laps,
            last: last,
            best: best,
            times: times,
            fuel: fuel,
            pit: pit,
            pits: pits,
            sector: curr.length - 1 || prev.length,
            finished: finished
          };
        }),
        publishReplay(1),
        refCount()
      );
    }),
    publishReplay(),
    refCount()
    );
  }

  private finish(id?: number) {
    console.log('finish() called with id:', id, 'finished.value:', this.finished.value);
    const mask = this.mask;
    this.mask |= (~this.active & 0xff);
    if (id !== undefined) {
      // Ne bloquer la voiture que si :
      // 1. Elle n'a pas été débloquée manuellement
      // 2. Elle n'a pas déjà été bloquée automatiquement (pour éviter de rebloquer après un déblocage)
      const carId = id + 1; // id est 0-based, car_id est 1-based
      const isManuallyUnblocked = this.carSync && this.carSync.isCarManuallyUnblocked(carId);
      const alreadyAutoBlocked = this.autoBlockedCars.has(id);

      if (!isManuallyUnblocked && !alreadyAutoBlocked) {
        this.mask |= (1 << id);
        this.autoBlockedCars.add(id); // Marquer comme ayant été bloquée automatiquement
        console.log(`🔒 Car ${carId} auto-blocked on finish (first time)`);
      } else if (isManuallyUnblocked) {
        // Si la voiture est débloquée manuellement, retirer le blocage du mask
        this.mask &= ~(1 << id);
        console.log(`✅ Car ${carId} is manually unblocked, removing from mask`);
      } else if (alreadyAutoBlocked) {
        console.log(`⏭️ Car ${carId} already auto-blocked once, skipping`);
      }
    }
    if (mask != this.mask) {
      this.cu.setMask(this.mask);
    }
    if (id !== undefined) {
      this.cu.setFinished(id);
    }

    // Quand la course est complètement terminée : consommer les pièces et bloquer les voitures
    if (this.carSync && id === undefined && !this.coinsConsumed) {
      console.log('Race fully finished');
      this.coinsConsumed = true; // Marquer pour ne consommer qu'une seule fois

      // Consommer les pièces seulement si ce n'est pas un arrêt manuel
      if (!this.manuallyStopped) {
        console.log('Marking coins as consumed for all participating cars');

        // Récupérer les IDs des voitures qui ont participé (non masquées par le paiement)
        const participatingCarIds: number[] = [];
        for (let i = 0; i < 6; i++) {
          if ((this.unpaidMask & (1 << i)) === 0) {
            participatingCarIds.push(i + 1); // car_id est 1-based
          }
        }

        // Marquer les pièces comme consommées
        if (participatingCarIds.length > 0) {
          this.carSync.markCoinsAsConsumed(participatingCarIds);
        }
      } else {
        console.log('Race manually stopped - coins NOT consumed');
      }

      // Bloquer toutes les voitures actives
      console.log('Blocking all active cars');
      this.carSync.blockAllActiveCars().subscribe({
        next: (blockResults) => {
          console.log('All active cars blocked:', blockResults);
        },
        error: (error) => {
          console.error('Error blocking cars:', error);
        }
      });
    }

    // Marquer la course comme terminée seulement si c'est la fin complète (pas juste une voiture)
    if (id === undefined) {
      this.finished.next(true);
    }
  }

  private isFinished(laps: number) {
    if (this.stopped) {
      return true;
    } else if (this.options.laps && laps >= this.options.laps) {
      return true;
    } else if (!this.options.slotmode && this.finished.value) {
      return true;
    } else {
      return false;
    }
  }
}
