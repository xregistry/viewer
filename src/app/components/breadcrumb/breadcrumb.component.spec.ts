import { DefaultUrlSerializer, Router } from '@angular/router';
import { of, Subject } from 'rxjs';

import { BreadcrumbComponent } from './breadcrumb.component';

describe('BreadcrumbComponent', () => {
  it('uses semantic route segments for resource lookups and encoded breadcrumb links', () => {
    const serializer = new DefaultUrlSerializer();
    const router = {
      url: '/goregistries/pkg.go.dev/modules/4d63.com%2Fbiblepassageapi',
      events: new Subject(),
      parseUrl: (url: string) => serializer.parse(url),
      createUrlTree: (commands: string[]) => serializer.parse(
        `/${commands.slice(1).map(segment => encodeURIComponent(segment)).join('/')}`
      )
    } as unknown as Router;
    const modelService = {
      getRegistryModel: jest.fn(() => of({
        groups: {
          goregistries: {
            plural: 'Go registries',
            resources: { modules: { plural: 'Modules' } }
          }
        }
      }))
    };
    const registryService = {
      getGroup: jest.fn(() => of({ name: 'Go Module Proxy' })),
      getResource: jest.fn(() => of({ name: '4d63.com/biblepassageapi' }))
    };
    const component = new BreadcrumbComponent(
      router,
      modelService as never,
      registryService as never,
      { clearStoredRoute: jest.fn() } as never,
      'server'
    );

    component.ngOnInit();

    component.breadcrumbs$.subscribe(breadcrumbs => {
      expect(registryService.getResource).toHaveBeenCalledWith(
        'goregistries',
        'pkg.go.dev',
        'modules',
        '4d63.com/biblepassageapi'
      );
      expect(serializer.serialize(breadcrumbs[3].url)).toBe(
        '/goregistries/pkg.go.dev/modules/4d63.com%2Fbiblepassageapi'
      );
    });
  });
});
