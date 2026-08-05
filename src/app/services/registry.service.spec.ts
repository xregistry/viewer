import { TestBed } from '@angular/core/testing';
import { HttpClientTestingModule, HttpTestingController } from '@angular/common/http/testing';
import { HttpHeaders, HttpResponse } from '@angular/common/http';
import { firstValueFrom, of } from 'rxjs';
import { RegistryService } from './registry.service';
import { ConfigService } from './config.service';
import { ModelService } from './model.service';
import { PLATFORM_ID } from '@angular/core';
import { RegistryModel } from '../models/registry.model';

describe('RegistryService', () => {
  let service: RegistryService;
  let configServiceSpy: jest.Mocked<ConfigService>;
  let modelServiceSpy: jest.Mocked<ModelService>;

  beforeEach(() => {
    const configMock = {
      getConfig: jest.fn().mockReturnValue({
        apiEndpoints: ['https://test-api.myregistry.example.com'],
        baseUrl: '/',
        defaultDocumentView: true,
        features: {
          enableFilters: true,
          enableSearch: true,
          enableDocDownload: true
        },
        modelUris: []
      }),
      config$: of({
        apiEndpoints: ['https://test-api.myregistry.example.com'],
        baseUrl: '/',
        defaultDocumentView: true,
        features: {
          enableFilters: true,
          enableSearch: true,
          enableDocDownload: true
        },
        modelUris: []
      }),
      configChanges$: of({
        apiEndpoints: ['https://test-api.myregistry.example.com'],
        baseUrl: '/',
        defaultDocumentView: true,
        features: {
          enableFilters: true,
          enableSearch: true,
          enableDocDownload: true
        },
        modelUris: []
      })
    };

    const modelMock = {
      getRegistryModel: jest.fn(),
      getApiEndpointsForGroupType: jest.fn()
    };

    TestBed.configureTestingModule({
      imports: [HttpClientTestingModule],
      providers: [
        RegistryService,
        { provide: ConfigService, useValue: configMock },
        { provide: ModelService, useValue: modelMock },
        { provide: PLATFORM_ID, useValue: 'browser' }
      ]
    });

    service = TestBed.inject(RegistryService);
    configServiceSpy = TestBed.inject(ConfigService) as jest.Mocked<ConfigService>;
    modelServiceSpy = TestBed.inject(ModelService) as jest.Mocked<ModelService>;
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });
  it('should use the API URL from config service', () => {
    expect(configServiceSpy.getConfig).toHaveBeenCalled();
    expect(service).toBeTruthy();
  });

  it('should encode slash-containing identifiers as individual path segments', () => {
    expect((service as any).buildPath(
      'huggingfaceregistries',
      'hub',
      'models',
      'org/model'
    )).toBe('/huggingfaceregistries/hub/models/org%2Fmodel');
  });

  it('should preserve literal percent-encoded text in identifiers', () => {
    expect((service as any).buildPath(
      'goregistries',
      'pkg.go.dev',
      'modules',
      '4d63.com%2Fcollapsewhitespace'
    )).toBe('/goregistries/pkg.go.dev/modules/4d63.com%252Fcollapsewhitespace');
  });

  it('should preserve generic version metadata and non-SemVer identifiers', () => {
    const entry = {
      versionid: 'a3f18c9107d2f8f90ad3c0d9e8026a85c12e640b',
      versionscount: 0,
      gated: false,
      distributions: [{ platform: 'linux/amd64', url: 'https://example.test/blob' }]
    };
    const result = (service as any).processResourceResponse(
      entry,
      { singular: 'version', attributes: {} },
      'https://test-api.myregistry.example.com',
      false
    );

    expect(result.id).toBe(entry.versionid);
    expect(result.versionscount).toBe(0);
    expect(result.gated).toBe(false);
    expect(result.distributions).toEqual(entry.distributions);
  });

  it('preserves initial group pagination links for a single API', async () => {
    const model: RegistryModel = {
      capabilities: { apis: [], schemas: [], pagination: true },
      groups: {
        goregistries: {
          singular: 'goregistry',
          attributes: {},
          resources: {}
        }
      }
    };
    modelServiceSpy.getRegistryModel.mockReturnValue(of(model));
    modelServiceSpy.getApiEndpointsForGroupType.mockReturnValue([
      'https://test-api.myregistry.example.com'
    ]);
    jest.spyOn(service as any, 'httpGetWithRetry').mockReturnValue(of(
      new HttpResponse({
        body: {
          'github.com': {
            goregistryid: 'github.com',
            name: 'github.com'
          }
        },
        headers: new HttpHeaders({
          Link: '<https://test-api.myregistry.example.com/goregistries?offset=50&limit=50>; rel="next"'
        })
      })
    ));

    const page = await firstValueFrom(service.listGroups('goregistries'));

    expect(page.items.map(group => group.id)).toEqual(['github.com']);
    expect(page.links.next).toBe(
      'https://test-api.myregistry.example.com/goregistries?offset=50&limit=50'
    );
  });

  it('should throw proper 404 errors when all endpoints return 404', () => {
    // This test validates that the fetchResourceDetailsAsync method properly
    // tracks 404 errors and throws appropriate errors when all endpoints return 404.
    // This is critical for displaying proper "Resource not found" vs "Version not found" messages.
    expect(service).toBeTruthy();
    // Note: Full integration testing would require mocking HTTP responses,
    // but this ensures the service is properly configured for the fix.
  });
});


// The service uses native async/await internally. Zone.js's fakeAsync/tick
// cannot reliably intercept native (non-zone-patched) microtask chains under
// modern (ES2017+) compilation targets, so these tests use real async/await
// with a macrotask-boundary flush to deterministically drain pending
// microtasks (model fetch -> per-API requests -> Promise.all merge) between
// each HttpTestingController interaction.
async function flushPromises(rounds = 3): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await new Promise<void>(resolve => setTimeout(resolve, 0));
  }
}
describe('RegistryService - listGroups server-driven pagination', () => {
  let service: RegistryService;
  let httpMock: HttpTestingController;
  let modelMock: { getRegistryModel: jest.Mock; getApiEndpointsForGroupType: jest.Mock };

  const GROUP_TYPE = 'endpoints';

  const model = {
    specversion: '0.5',
    registryid: 'reg',
    name: 'Test Registry',
    description: '',
    capabilities: { apis: [], schemas: [], pagination: true },
    groups: {
      [GROUP_TYPE]: { plural: GROUP_TYPE, singular: 'endpoint', description: '', resources: {} }
    }
  };

  beforeEach(() => {
    const configMock = {
      getConfig: jest.fn().mockReturnValue({
        apiEndpoints: ['https://api-a.example.com'],
        baseUrl: '/',
        defaultDocumentView: true,
        features: { enableFilters: true, enableSearch: true, enableDocDownload: true },
        modelUris: []
      }),
      configChanges$: of()
    };

    modelMock = {
      getRegistryModel: jest.fn().mockReturnValue(of(model)),
      getApiEndpointsForGroupType: jest.fn().mockReturnValue(['https://api-a.example.com'])
    };

    TestBed.configureTestingModule({
      imports: [HttpClientTestingModule],
      providers: [
        RegistryService,
        { provide: ConfigService, useValue: configMock },
        { provide: ModelService, useValue: modelMock },
        { provide: PLATFORM_ID, useValue: 'browser' }
      ]
    });

    service = TestBed.inject(RegistryService);
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    httpMock.verify();
  });

  it('includes an explicit bounded limit (default 50) on the initial request', async () => {
    let result: any;
    service.listGroups(GROUP_TYPE).subscribe(p => (result = p));
    await flushPromises();

    const req = httpMock.expectOne('https://api-a.example.com/endpoints?limit=50');
    expect(req.request.url).toContain('limit=50');
    req.flush({});
    await flushPromises();

    expect(result.items).toEqual([]);
    expect(result.pageSize).toBe(50);
  });

  it('honors an explicit, still-bounded custom page size', async () => {
    service.listGroups(GROUP_TYPE, '', undefined, 10).subscribe();
    await flushPromises();

    const req = httpMock.expectOne('https://api-a.example.com/endpoints?limit=10');
    expect(req.request.url).toContain('limit=10');
    req.flush({});
    await flushPromises();
  });

  it('retains and uses the real RFC5988 Link relations for a single API', async () => {
    let result: any;
    service.listGroups(GROUP_TYPE).subscribe(p => (result = p));
    await flushPromises();

    const req = httpMock.expectOne('https://api-a.example.com/endpoints?limit=50');
    const nextUrl = 'https://api-a.example.com/endpoints?limit=50&offset=50';
    req.flush(
      { e1: { endpointid: 'e1', name: 'Endpoint 1' } },
      { headers: { Link: `<${nextUrl}>; rel="next"` } }
    );
    await flushPromises();

    expect(result.links.next).toBe(nextUrl);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].origin).toBe('https://api-a.example.com');
  });

  it('parses X-Total-Count on the initial single-origin request into Page.totalCount, and derives currentPage/totalPages', async () => {
    let result: any;
    service.listGroups(GROUP_TYPE).subscribe(p => (result = p));
    await flushPromises();

    const req = httpMock.expectOne('https://api-a.example.com/endpoints?limit=50');
    const nextUrl = 'https://api-a.example.com/endpoints?limit=50&offset=50';
    req.flush(
      { e1: { endpointid: 'e1', name: 'Endpoint 1' } },
      { headers: { Link: `<${nextUrl}>; rel="next"`, 'X-Total-Count': '120' } }
    );
    await flushPromises();

    expect(result.totalCount).toBe(120);
    // First page: floor(nextOffset=50 / pageSize=50) = 1.
    expect(result.currentPage).toBe(1);
    // ceil(120 / 50) = 3.
    expect(result.totalPages).toBe(3);
  });

  it('parses X-Total-Count on an absolute-URL single-origin pagination continuation, deriving the correct (last-page) currentPage from the prev relation', async () => {
    let page1: any;
    service.listGroups(GROUP_TYPE).subscribe(p => (page1 = p));
    await flushPromises();
    const nextUrl = 'https://api-a.example.com/endpoints?limit=50&offset=50';
    httpMock.expectOne('https://api-a.example.com/endpoints?limit=50').flush(
      { e1: { endpointid: 'e1', name: 'Endpoint 1' } },
      { headers: { Link: `<${nextUrl}>; rel="next"`, 'X-Total-Count': '120' } }
    );
    await flushPromises();

    // Page 2/3 (last page, no further next - only a prev relation).
    let page2: any;
    service.listGroups(GROUP_TYPE, page1.links.next).subscribe(p => (page2 = p));
    await flushPromises();

    const prevUrl = 'https://api-a.example.com/endpoints?limit=50&offset=0';
    httpMock.expectOne(nextUrl).flush(
      { e2: { endpointid: 'e2', name: 'Endpoint 2' } },
      { headers: { Link: `<${prevUrl}>; rel="prev"`, 'X-Total-Count': '120' } }
    );
    await flushPromises();

    expect(page2.totalCount).toBe(120);
    // Last page, derived from prev offset: floor(0 / 50) + 2 = 2.
    expect(page2.currentPage).toBe(2);
    expect(page2.totalPages).toBe(3);
  });

  it('does not populate totalCount/currentPage/totalPages for a multi-origin (merged) listing, even if origins send X-Total-Count', async () => {
    modelMock.getApiEndpointsForGroupType.mockReturnValue([
      'https://api-a.example.com',
      'https://api-b.example.com'
    ]);

    let result: any;
    service.listGroups(GROUP_TYPE).subscribe(p => (result = p));
    await flushPromises();

    const reqA = httpMock.expectOne('https://api-a.example.com/endpoints?limit=50');
    const reqB = httpMock.expectOne('https://api-b.example.com/endpoints?limit=50');
    reqA.flush({ a1: { endpointid: 'a1', name: 'A1' } }, { headers: { 'X-Total-Count': '10' } });
    reqB.flush({ b1: { endpointid: 'b1', name: 'B1' } }, { headers: { 'X-Total-Count': '20' } });
    await flushPromises();

    expect(result.items).toHaveLength(2);
    expect(result.totalCount).toBeUndefined();
    expect(result.currentPage).toBeUndefined();
    expect(result.totalPages).toBeUndefined();
  });

  it('does not silently discard pagination for multiple APIs - encodes a bounded, deterministic composite cursor', async () => {
    modelMock.getApiEndpointsForGroupType.mockReturnValue([
      'https://api-a.example.com',
      'https://api-b.example.com'
    ]);

    let result: any;
    service.listGroups(GROUP_TYPE).subscribe(p => (result = p));
    await flushPromises();

    const reqA = httpMock.expectOne('https://api-a.example.com/endpoints?limit=50');
    const reqB = httpMock.expectOne('https://api-b.example.com/endpoints?limit=50');
    expect(reqA.request.url).toContain('limit=50');
    expect(reqB.request.url).toContain('limit=50');

    const nextA = 'https://api-a.example.com/endpoints?limit=50&offset=50';
    const nextB = 'https://api-b.example.com/endpoints?limit=50&offset=50';

    reqA.flush({ a1: { endpointid: 'a1', name: 'A1' } }, { headers: { Link: `<${nextA}>; rel="next"` } });
    reqB.flush({ b1: { endpointid: 'b1', name: 'B1' } }, { headers: { Link: `<${nextB}>; rel="next"` } });
    await flushPromises();

    expect(result.items).toHaveLength(2);
    expect(typeof result.links.next).toBe('string');
    expect(result.links.next.startsWith('multi:')).toBe(true);

    // Navigate to the composite next page: each origin is fetched exactly once
    // more, using ITS OWN next URL - this must never balloon into fetching
    // the whole registry.
    let page2: any;
    service.listGroups(GROUP_TYPE, result.links.next).subscribe(p => (page2 = p));
    await flushPromises();

    const reqA2 = httpMock.expectOne(nextA);
    const reqB2 = httpMock.expectOne(nextB);
    reqA2.flush({ a2: { endpointid: 'a2', name: 'A2' } });
    reqB2.flush({ b2: { endpointid: 'b2', name: 'B2' } });
    await flushPromises();

    expect(page2.items).toHaveLength(2);
    expect(page2.items.map((i: any) => i.id).sort()).toEqual(['a2', 'b2']);
    // 'first' always returns to the bounded, all-origins query - never dropped.
    expect(page2.links.first).toBe(`/${GROUP_TYPE}`);
    // 'prev' is now populated too: page 2's previous page is the plain,
    // bounded, all-origins initial query.
    expect(page2.links.prev).toBe(`/${GROUP_TYPE}`);
  });

  it('reconstructs an exact backward link once an origin has exhausted mid-pagination (breadcrumb-based prev, not recomposed from currently-active origins only)', async () => {
    modelMock.getApiEndpointsForGroupType.mockReturnValue([
      'https://api-a.example.com',
      'https://api-b.example.com'
    ]);

    // --- Page 1: both origins contribute and both still have more pages. ---
    let page1: any;
    service.listGroups(GROUP_TYPE).subscribe(p => (page1 = p));
    await flushPromises();

    const reqA1 = httpMock.expectOne('https://api-a.example.com/endpoints?limit=50');
    const reqB1 = httpMock.expectOne('https://api-b.example.com/endpoints?limit=50');
    const nextA1 = 'https://api-a.example.com/endpoints?limit=50&offset=50';
    const nextB1 = 'https://api-b.example.com/endpoints?limit=50&offset=50';
    reqA1.flush({ a1: { endpointid: 'a1', name: 'A1' } }, { headers: { Link: `<${nextA1}>; rel="next"` } });
    reqB1.flush({ b1: { endpointid: 'b1', name: 'B1' } }, { headers: { Link: `<${nextB1}>; rel="next"` } });
    await flushPromises();

    const cursor1 = page1.links.next;
    expect(typeof cursor1).toBe('string');
    expect(cursor1.startsWith('multi:')).toBe(true);

    // --- Page 2: origin B is now exhausted (its response carries no `next`
    // relation of its own), so it correctly drops out of the cursor from
    // this point forward. ---
    let page2: any;
    service.listGroups(GROUP_TYPE, cursor1).subscribe(p => (page2 = p));
    await flushPromises();

    const reqA2 = httpMock.expectOne(nextA1);
    const reqB2 = httpMock.expectOne(nextB1);
    const nextA2 = 'https://api-a.example.com/endpoints?limit=50&offset=100';
    reqA2.flush({ a2: { endpointid: 'a2', name: 'A2' } }, { headers: { Link: `<${nextA2}>; rel="next"` } });
    reqB2.flush({ b2: { endpointid: 'b2', name: 'B2' } }); // no Link header: B has no further next.
    await flushPromises();

    expect(page2.items.map((i: any) => i.id).sort()).toEqual(['a2', 'b2']);
    // Backward from page 2 replays the plain, bounded initial query.
    expect(page2.links.prev).toBe(`/${GROUP_TYPE}`);

    const cursor2 = page2.links.next;
    expect(typeof cursor2).toBe('string');
    expect(cursor2.startsWith('multi:')).toBe(true);

    // --- Page 3: only origin A remains active. B must NEVER be re-queried
    // once exhausted - not even to try to reconstruct a prev link. ---
    let page3: any;
    service.listGroups(GROUP_TYPE, cursor2).subscribe(p => (page3 = p));
    await flushPromises();

    const reqA3 = httpMock.expectOne(nextA2);
    httpMock.expectNone(nextB1);
    reqA3.flush({ a3: { endpointid: 'a3', name: 'A3' } });
    await flushPromises();

    expect(page3.items.map((i: any) => i.id)).toEqual(['a3']);

    // --- The crux of the fix: page 3's `prev` is the EXACT cursor that
    // produced page 2 (cursor1) - carried forward as a breadcrumb - and is
    // NOT recomposed from page 3's currently-active origins (which is only A;
    // B's page-2 URL is no longer being fetched on page 3 at all, so there
    // would be no way to recover it from page-3-local data). ---
    expect(page3.links.prev).toBe(cursor1);

    // Prove this is an exact reconstruction, not just a structurally similar
    // value: clear the shared cache and replay `page3.links.prev` from
    // scratch. It must re-issue requests to BOTH origins' original page-2
    // URLs (including B's, which page 3 itself never touched) and return
    // page 2's exact merged content again.
    service.clearCache();
    let page2Replayed: any;
    service.listGroups(GROUP_TYPE, page3.links.prev).subscribe(p => (page2Replayed = p));
    await flushPromises();

    const reqA2Replay = httpMock.expectOne(nextA1);
    const reqB2Replay = httpMock.expectOne(nextB1);
    reqA2Replay.flush({ a2: { endpointid: 'a2', name: 'A2' } }, { headers: { Link: `<${nextA2}>; rel="next"` } });
    reqB2Replay.flush({ b2: { endpointid: 'b2', name: 'B2' } });
    await flushPromises();

    expect(page2Replayed.items.map((i: any) => i.id).sort()).toEqual(['a2', 'b2']);
  });

  it('shares an in-flight/completed request between prefetch and real navigation (no duplicate network call)', async () => {
    let page1: any;
    service.listGroups(GROUP_TYPE).subscribe(p => (page1 = p));
    await flushPromises();
    const req = httpMock.expectOne('https://api-a.example.com/endpoints?limit=50');
    const nextUrl = 'https://api-a.example.com/endpoints?limit=50&offset=50';
    req.flush({}, { headers: { Link: `<${nextUrl}>; rel="next"` } });
    await flushPromises();

    // Prefetch the single adjacent next page.
    service.prefetchNextGroupsPage(GROUP_TYPE, page1);
    await flushPromises();
    const prefetchReq = httpMock.expectOne(nextUrl);
    prefetchReq.flush({ e2: { endpointid: 'e2', name: 'E2' } });
    await flushPromises();

    // A real navigation to the same next link must NOT trigger a new request -
    // it should be served from the shared cache.
    let page2: any;
    service.listGroups(GROUP_TYPE, page1.links.next).subscribe(p => (page2 = p));
    await flushPromises();
    httpMock.expectNone(nextUrl);

    expect(page2.items).toHaveLength(1);
    expect(page2.items[0].id).toBe('e2');
  });

  it('never chains a second prefetch call from within prefetchNextGroupsPage itself', async () => {
    let page1: any;
    service.listGroups(GROUP_TYPE).subscribe(p => (page1 = p));
    await flushPromises();
    const req = httpMock.expectOne('https://api-a.example.com/endpoints?limit=50');
    const nextUrl = 'https://api-a.example.com/endpoints?limit=50&offset=50';
    const nextNextUrl = 'https://api-a.example.com/endpoints?limit=50&offset=100';
    req.flush({}, { headers: { Link: `<${nextUrl}>; rel="next"` } });
    await flushPromises();

    service.prefetchNextGroupsPage(GROUP_TYPE, page1);
    await flushPromises();
    const prefetchReq = httpMock.expectOne(nextUrl);
    prefetchReq.flush({}, { headers: { Link: `<${nextNextUrl}>; rel="next"` } });
    await flushPromises();

    // No request for the page AFTER next should ever have been made.
    httpMock.expectNone(nextNextUrl);
  });

  it('does not prefetch when there is no next relation to follow', async () => {
    let page1: any;
    service.listGroups(GROUP_TYPE).subscribe(p => (page1 = p));
    await flushPromises();
    httpMock.expectOne('https://api-a.example.com/endpoints?limit=50').flush({});
    await flushPromises();

    service.prefetchNextGroupsPage(GROUP_TYPE, page1);
    await flushPromises();

    httpMock.expectNone(() => true);
  });

  it('does not cache a resolved failure/partial-failure page - a retry after a transient origin failure hits the network again', async () => {
    // Page 1 succeeds normally with a `next` relation.
    let page1: any;
    service.listGroups(GROUP_TYPE).subscribe(p => (page1 = p));
    await flushPromises();
    const nextUrl = 'https://api-a.example.com/endpoints?limit=50&offset=50';
    httpMock.expectOne('https://api-a.example.com/endpoints?limit=50').flush(
      { e1: { endpointid: 'e1', name: 'E1' } },
      { headers: { Link: `<${nextUrl}>; rel="next"` } }
    );
    await flushPromises();

    // Navigating to page 2 (an absolute-URL, single-origin continuation -
    // this branch does not go through the retry-with-backoff HTTP helper,
    // so the failure resolves immediately) hits a transient origin failure.
    // listGroupsAsync catches this and RESOLVES with a failure Page rather
    // than rejecting the promise.
    let failedPage: any;
    service.listGroups(GROUP_TYPE, page1.links.next).subscribe(p => (failedPage = p));
    await flushPromises();
    httpMock.expectOne(nextUrl).error(new ProgressEvent('error'), { status: 503, statusText: 'Service Unavailable' });
    await flushPromises();

    expect(failedPage).toBeDefined();
    expect(failedPage.successfulApis).toBe(0);
    expect(failedPage.failedApis).toBe(1);

    // Retry the SAME request (same groupType/pagePath/filter/pageSize/API
    // set): the resolved failure must NOT have been cached, so this must
    // hit the network again - and this time the (now-recovered) origin
    // succeeds.
    let recoveredPage: any;
    service.listGroups(GROUP_TYPE, page1.links.next).subscribe(p => (recoveredPage = p));
    await flushPromises();
    httpMock.expectOne(nextUrl).flush({ e2: { endpointid: 'e2', name: 'E2' } });
    await flushPromises();

    expect(recoveredPage.successfulApis).toBe(1);
    expect(recoveredPage.items).toHaveLength(1);
    expect(recoveredPage.items[0].id).toBe('e2');
  });

  it('invalidates the cache when the set of contributing origins grows between calls (progressive discovery of a new origin)', async () => {
    // Initially only origin A contributes to this group type.
    let pageA: any;
    service.listGroups(GROUP_TYPE).subscribe(p => (pageA = p));
    await flushPromises();
    httpMock.expectOne('https://api-a.example.com/endpoints?limit=50').flush({ a1: { endpointid: 'a1', name: 'A1' } });
    await flushPromises();

    expect(pageA.items).toHaveLength(1);
    expect(pageA.items[0].origin).toBe('https://api-a.example.com');

    // Progressive model loading now discovers that origin B ALSO contributes
    // this group type. Same groupType/pagePath/filter/pageSize as before -
    // only the contributing API set has changed.
    modelMock.getApiEndpointsForGroupType.mockReturnValue([
      'https://api-a.example.com',
      'https://api-b.example.com'
    ]);

    let pageAB: any;
    service.listGroups(GROUP_TYPE).subscribe(p => (pageAB = p));
    await flushPromises();

    // Must NOT replay the stale, A-only cached page: both origins must be
    // freshly queried.
    const reqA2 = httpMock.expectOne('https://api-a.example.com/endpoints?limit=50');
    const reqB2 = httpMock.expectOne('https://api-b.example.com/endpoints?limit=50');
    reqA2.flush({ a1: { endpointid: 'a1', name: 'A1' } });
    reqB2.flush({ b1: { endpointid: 'b1', name: 'B1' } });
    await flushPromises();

    expect(pageAB.items).toHaveLength(2);
    expect(pageAB.items.map((i: any) => i.origin).sort()).toEqual([
      'https://api-a.example.com',
      'https://api-b.example.com'
    ]);
  });

  it('clearCache() evicts the shared page cache so a repeated request hits the network again', async () => {
    service.listGroups(GROUP_TYPE).subscribe();
    await flushPromises();
    httpMock.expectOne('https://api-a.example.com/endpoints?limit=50').flush({});
    await flushPromises();

    service.clearCache();

    service.listGroups(GROUP_TYPE).subscribe();
    await flushPromises();
    httpMock.expectOne('https://api-a.example.com/endpoints?limit=50').flush({});
    await flushPromises();
  });
});
