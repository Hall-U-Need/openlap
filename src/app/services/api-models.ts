export interface ApiCar {
  name: string;
  car_id: number;
  accelerator_percent: number;
  button_pressed: boolean;
  active: boolean;
  blocked: boolean; // État de blocage de la voiture
  coin_value: number; // Montant payé par le joueur (remplace has_coin)
  manually_unblocked: boolean; // La voiture a été débloquée manuellement
  manually_blocked: boolean; // La voiture a été bloquée manuellement (prioritaire sur coin_value)
  last_seen: number;
  frame_count: number;
  throttle_raw: number;
  frame_raw: number;
  frame_id: number;
  window_id: number;
}

export interface CoinAcceptor {
  id: number;
  gpio: number;
  coin_count: number;
  last_coin_time: number;
  time_since_last_coin: number;
}

export interface ApiResponse {
  cars: ApiCar[];
  coin_acceptors: CoinAcceptor[];
  timestamp: number;
}