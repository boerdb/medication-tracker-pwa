import { Component, OnDestroy, OnInit } from '@angular/core';
import { Router } from '@angular/router';

const LANDING_MS = 4000;

@Component({
  selector: 'app-landing',
  templateUrl: './landing.page.html',
  styleUrls: ['./landing.page.scss'],
  standalone: false,
})
export class LandingPage implements OnInit, OnDestroy {
  private timerId: ReturnType<typeof setTimeout> | null = null;

  constructor(private router: Router) {}

  ngOnInit(): void {
    this.timerId = window.setTimeout(() => {
      void this.router.navigateByUrl('/home', { replaceUrl: true });
    }, LANDING_MS);
  }

  ngOnDestroy(): void {
    if (this.timerId !== null) {
      window.clearTimeout(this.timerId);
      this.timerId = null;
    }
  }
}
