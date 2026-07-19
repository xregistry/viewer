import { TestBed } from '@angular/core/testing';
import { DefaultUrlSerializer, provideRouter, Router } from '@angular/router';
import { buildEncodedRoute, getPrimaryRouteSegment } from './route.utils';

describe('buildEncodedRoute', () => {
  let router: Router;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideRouter([])]
    });
    router = TestBed.inject(Router);
  });

  it('keeps slash-containing resource and version IDs in single URL segments', () => {
    const serializer = new DefaultUrlSerializer();

    const route = buildEncodedRoute(
      router,
      'huggingfaceregistries',
      'hub',
      'models',
      'org/model',
      'versions',
      'feature/main'
    );

    expect(serializer.serialize(route)).toBe(
      '/huggingfaceregistries/hub/models/org%2Fmodel/versions/feature%2Fmain'
    );
  });

  it('preserves literal percent-encoded text as part of an identifier', () => {
    const serializer = new DefaultUrlSerializer();
    const route = buildEncodedRoute(router, 'groups', 'pkg%2Fname');

    expect(serializer.serialize(route)).toBe('/groups/pkg%252Fname');
  });

  it('reads semantic identifiers from serialized primary route segments', () => {
    const serializer = new DefaultUrlSerializer();
    const slashRoute = buildEncodedRoute(router, 'groups', 'hub', 'models', 'org/model');
    const percentRoute = buildEncodedRoute(router, 'groups', 'hub', 'models', 'pkg%2Fname');
    const literalPercentRoute = buildEncodedRoute(router, 'groups', 'hub', 'models', '100%');

    expect(getPrimaryRouteSegment(
      serializer.parse(serializer.serialize(slashRoute)),
      3
    )).toBe('org/model');
    expect(getPrimaryRouteSegment(
      serializer.parse(serializer.serialize(percentRoute)),
      3
    )).toBe('pkg%2Fname');
    expect(getPrimaryRouteSegment(
      serializer.parse(serializer.serialize(literalPercentRoute)),
      3
    )).toBe('100%');
  });
});
