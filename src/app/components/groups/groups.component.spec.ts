import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute } from '@angular/router';
import { HttpClientTestingModule } from '@angular/common/http/testing';
import { of, Subject } from 'rxjs';

import { GroupsComponent } from './groups.component';
import { RegistryService } from '../../services/registry.service';
import { ConfigService } from '../../services/config.service';
import { ModelService } from '../../services/model.service';
import { IconComponent } from '../icon/icon.component';
import { SearchService } from '../../services/search.service';
import { PLATFORM_ID, CUSTOM_ELEMENTS_SCHEMA } from '@angular/core';
import { By } from '@angular/platform-browser';
import { PageHeaderComponent } from '../page-header/page-header.component';

describe('GroupsComponent', () => {
  let component: GroupsComponent;
  let fixture: ComponentFixture<GroupsComponent>;  beforeEach(async () => {
    const activatedRouteMock = {
      params: of({}),
      queryParams: of({}),
      queryParamMap: of({
        get: jest.fn(() => '')
      }),
      snapshot: {
        params: {},
        queryParams: {},
        paramMap: {
          get: jest.fn((key: string) => {
            const params: { [key: string]: string } = {};
            return params[key] || '';
          })
        },
        queryParamMap: {
          get: jest.fn(() => '')
        }
      }
    };    await TestBed.configureTestingModule({
      imports: [
        GroupsComponent,
        HttpClientTestingModule
      ],providers: [
        RegistryService,
        ConfigService,
        ModelService,
        { provide: ActivatedRoute, useValue: activatedRouteMock },
        { provide: PLATFORM_ID, useValue: 'browser' }
      ],
      schemas: [CUSTOM_ELEMENTS_SCHEMA]
    })
    .compileComponents();

    fixture = TestBed.createComponent(GroupsComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('shows pagination controls when the server returns a next link', () => {
    component.useClientSidePagination = false;
    component.pageLinks = {
      next: 'https://registry.example.test/goregistries?offset=50&limit=50'
    };

    fixture.detectChanges();

    const header = fixture.debugElement.query(By.directive(PageHeaderComponent))
      .componentInstance as PageHeaderComponent;
    expect(header.showPagination).toBe(true);
  });
});


describe('GroupsComponent - server-driven group pagination', () => {
  let component: GroupsComponent;
  let fixture: ComponentFixture<GroupsComponent>;
  let registryMock: { listGroups: jest.Mock; prefetchNextGroupsPage: jest.Mock };
  let modelMock: {
    getProgressiveRegistryModel: jest.Mock;
    getRegistryModel: jest.Mock;
    getApiEndpointsForGroupType: jest.Mock;
    clearAllCaches: jest.Mock;
  };
  let progressiveSubject: Subject<{ model: any; isComplete: boolean; loadedCount: number; totalCount: number }>;

  const GROUP_TYPE = 'endpoints';

  function buildModel() {
    return {
      specversion: '0.5',
      registryid: 'reg',
      name: 'Test Registry',
      description: '',
      capabilities: { apis: [], schemas: [], pagination: true },
      groups: {
        [GROUP_TYPE]: {
          plural: GROUP_TYPE,
          singular: 'endpoint',
          description: '',
          resources: {}
        }
      }
    };
  }

  function emptyPage(links: { [rel: string]: string } = {}) {
    return { items: [], links, totalApis: 1, successfulApis: 1, failedApis: 0, pageSize: 50 };
  }

  const activatedRouteMock = {
    paramMap: of({ get: (key: string) => (key === 'groupType' ? GROUP_TYPE : '') }),
    queryParamMap: of({ get: () => '' }),
    snapshot: {
      paramMap: { get: (key: string) => (key === 'groupType' ? GROUP_TYPE : '') },
      queryParamMap: { get: () => '' }
    }
  };

  beforeEach(async () => {
    progressiveSubject = new Subject();

    registryMock = {
      listGroups: jest.fn().mockReturnValue(of(emptyPage())),
      prefetchNextGroupsPage: jest.fn()
    };

    modelMock = {
      getProgressiveRegistryModel: jest.fn().mockReturnValue(progressiveSubject.asObservable()),
      getRegistryModel: jest.fn().mockReturnValue(of(buildModel())),
      getApiEndpointsForGroupType: jest.fn().mockReturnValue(['https://api-a.example.com']),
      clearAllCaches: jest.fn()
    };

    const configMock = {
      getConfig: jest.fn().mockReturnValue({
        apiEndpoints: ['https://api-a.example.com'],
        baseUrl: '/',
        defaultDocumentView: true,
        features: { enableFilters: true, enableSearch: true, enableDocDownload: true },
        modelUris: []
      }),
      configChanges$: new Subject()
    };

    await TestBed.configureTestingModule({
      imports: [GroupsComponent],
      providers: [
        { provide: RegistryService, useValue: registryMock },
        { provide: ModelService, useValue: modelMock },
        { provide: ConfigService, useValue: configMock },
        { provide: ActivatedRoute, useValue: activatedRouteMock },
        { provide: PLATFORM_ID, useValue: 'browser' }
      ],
      schemas: [CUSTOM_ELEMENTS_SCHEMA]
    }).compileComponents();

    fixture = TestBed.createComponent(GroupsComponent);
    component = fixture.componentInstance;
  });

  it('requests the initial page with an explicit bounded page size (default 50)', () => {
    fixture.detectChanges(); // ngOnInit
    progressiveSubject.next({ model: buildModel(), isComplete: false, loadedCount: 1, totalCount: 1 });

    expect(registryMock.listGroups).toHaveBeenCalledTimes(1);
    expect(registryMock.listGroups).toHaveBeenCalledWith(GROUP_TYPE, '', '', 50);
  });

  it('does not issue a duplicate collection request for a completion update with an unchanged origin set', () => {
    fixture.detectChanges();

    // First emission: group type becomes available.
    progressiveSubject.next({ model: buildModel(), isComplete: false, loadedCount: 1, totalCount: 2 });
    // Second emission (completion): same contributing API set as before.
    progressiveSubject.next({ model: buildModel(), isComplete: true, loadedCount: 2, totalCount: 2 });

    expect(registryMock.listGroups).toHaveBeenCalledTimes(1);
  });

  it('reloads groups when the set of contributing origins actually changes between progressive updates', () => {
    fixture.detectChanges();

    modelMock.getApiEndpointsForGroupType.mockReturnValue(['https://api-a.example.com']);
    progressiveSubject.next({ model: buildModel(), isComplete: false, loadedCount: 1, totalCount: 2 });

    // A second, slower endpoint turns out to also serve this group type.
    modelMock.getApiEndpointsForGroupType.mockReturnValue(['https://api-a.example.com', 'https://api-b.example.com']);
    progressiveSubject.next({ model: buildModel(), isComplete: true, loadedCount: 2, totalCount: 2 });

    expect(registryMock.listGroups).toHaveBeenCalledTimes(2);
  });

  it('prefetches the adjacent next page (and only that page) when the server returns a next link', () => {
    const page = emptyPage({ next: 'https://api-a.example.com/endpoints?limit=50&offset=50' });
    registryMock.listGroups.mockReturnValue(of(page));

    fixture.detectChanges();
    progressiveSubject.next({ model: buildModel(), isComplete: true, loadedCount: 1, totalCount: 1 });

    expect(registryMock.prefetchNextGroupsPage).toHaveBeenCalledTimes(1);
    expect(registryMock.prefetchNextGroupsPage).toHaveBeenCalledWith(GROUP_TYPE, page, '', 50);
  });

  it('delegates the "should we prefetch" decision to the service, passing the current page through as-is', () => {
    // RegistryService.prefetchNextGroupsPage is itself a no-op unless page.links.next
    // is present (verified in registry.service.spec.ts). The component should simply
    // always report the current page/context so it never has to duplicate that logic.
    const page = emptyPage(); // no pagination links at all
    registryMock.listGroups.mockReturnValue(of(page));

    fixture.detectChanges();
    progressiveSubject.next({ model: buildModel(), isComplete: true, loadedCount: 1, totalCount: 1 });

    expect(registryMock.prefetchNextGroupsPage).toHaveBeenCalledTimes(1);
    expect(registryMock.prefetchNextGroupsPage).toHaveBeenCalledWith(GROUP_TYPE, page, '', 50);
  });

  it('exposes the server-reported totalCount (X-Total-Count derived) via serverTotalCount, and clears it on reload', () => {
    const page = { ...emptyPage({ next: 'https://api-a.example.com/endpoints?limit=50&offset=50' }), totalCount: 120 };
    registryMock.listGroups.mockReturnValue(of(page));

    fixture.detectChanges();
    progressiveSubject.next({ model: buildModel(), isComplete: true, loadedCount: 1, totalCount: 1 });

    expect(component.serverTotalCount).toBe(120);
  });

  it('leaves serverTotalCount undefined when the server response has no totalCount (e.g. a multi-origin merged listing)', () => {
    const page = emptyPage({ next: 'https://api-a.example.com/endpoints?limit=50&offset=50' });
    registryMock.listGroups.mockReturnValue(of(page));

    fixture.detectChanges();
    progressiveSubject.next({ model: buildModel(), isComplete: true, loadedCount: 1, totalCount: 1 });

    expect(component.serverTotalCount).toBeUndefined();
  });

  it('exposes showPagination based on whatever RFC5988 relations are currently present', () => {
    fixture.detectChanges();

    component.pageLinks = {};
    expect(component.showPagination).toBe(false);

    component.pageLinks = { next: 'https://api-a.example.com/endpoints?offset=50' };
    expect(component.showPagination).toBe(true);
  });

  it('exposes showPagination when using the client-side pagination fallback, even between navigations when pageLinks is momentarily empty', () => {
    fixture.detectChanges();

    component.pageLinks = {};
    component.useClientSidePagination = false;
    expect(component.showPagination).toBe(false);

    component.useClientSidePagination = true;
    expect(component.showPagination).toBe(true);
  });

  it('reloads groups with the generated filter when the search term changes, preserving search behavior', () => {
    fixture.detectChanges();
    progressiveSubject.next({ model: buildModel(), isComplete: true, loadedCount: 1, totalCount: 1 });

    registryMock.listGroups.mockClear();

    const searchService = TestBed.inject(SearchService);
    searchService.setSearchTerm('foo', { groupType: GROUP_TYPE });

    expect(registryMock.listGroups).toHaveBeenCalledTimes(1);
    const callArgs = registryMock.listGroups.mock.calls[0];
    expect(callArgs[0]).toBe(GROUP_TYPE);
    expect(callArgs[1]).toBe('');
    expect(callArgs[2]).toContain('foo');
    expect(callArgs[3]).toBe(50);
  });

  it('navigates using onPageChange with the exact link value provided by the server (opaque cursor support)', () => {
    fixture.detectChanges();
    progressiveSubject.next({ model: buildModel(), isComplete: true, loadedCount: 1, totalCount: 1 });
    registryMock.listGroups.mockClear();

    const multiCursor = 'multi:%7B%22https%3A%2F%2Fapi-a.example.com%22%3A%22https%3A%2F%2Fapi-a.example.com%2Fendpoints%3Foffset%3D50%22%7D';
    component.onPageChange(multiCursor);

    expect(registryMock.listGroups).toHaveBeenCalledWith(GROUP_TYPE, multiCursor, '', 50);
  });
});
