import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';

import { IonicModule } from '@ionic/angular';

import { SharedModule } from '../../shared';

import { LeaderboardComponent } from './leaderboard.component';
import { LeaderboardHeadComponent } from './leaderboard-head.component';
import { LeaderboardItemComponent } from './leaderboard-item.component';
import { LeaderboardLapComponent } from './leaderboard-lap.component';

@NgModule({
  declarations: [
    LeaderboardComponent,
    LeaderboardHeadComponent,
    LeaderboardItemComponent,
    LeaderboardLapComponent
  ],
  exports: [
    LeaderboardComponent
  ],
  imports: [
    CommonModule,
    FormsModule,
    IonicModule,
    SharedModule
  ]
})
export class LeaderboardModule {}
