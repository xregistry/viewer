import { PRIMARY_OUTLET, Router, UrlTree } from '@angular/router';

export function buildEncodedRoute(router: Router, ...segments: string[]): UrlTree {
  return router.createUrlTree(['/', ...segments]);
}

export function getPrimaryRouteSegment(
  tree: UrlTree,
  index: number,
  fallback = ''
): string {
  return tree.root.children[PRIMARY_OUTLET]?.segments[index]?.path ?? fallback;
}

export function getPrimaryRouteSegments(tree: UrlTree): string[] {
  return tree.root.children[PRIMARY_OUTLET]?.segments.map(segment => segment.path) ?? [];
}
