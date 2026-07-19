import { Router, UrlTree } from '@angular/router';

export function buildEncodedRoute(router: Router, ...segments: string[]): UrlTree {
  return router.createUrlTree(['/', ...segments]);
}
