import { Router, UrlTree } from '@angular/router';

export function buildEncodedRoute(router: Router, ...segments: string[]): UrlTree {
  const path = segments.map(segment => encodeURIComponent(segment)).join('/');
  return router.parseUrl(`/${path}`);
}
