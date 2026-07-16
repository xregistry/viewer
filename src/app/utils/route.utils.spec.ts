import { DefaultUrlSerializer, Router } from '@angular/router';
import { buildEncodedRoute } from './route.utils';

describe('buildEncodedRoute', () => {
  it('keeps slash-containing resource and version IDs in single URL segments', () => {
    const serializer = new DefaultUrlSerializer();
    const router = {
      parseUrl: (url: string) => serializer.parse(url)
    } as Router;

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
});
