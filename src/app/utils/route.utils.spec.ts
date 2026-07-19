import { TestBed } from '@angular/core/testing';
import { DefaultUrlSerializer, provideRouter, Router } from '@angular/router';
import { buildEncodedRoute } from './route.utils';

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
});
