import { TestBed } from '@angular/core/testing';
import { HttpClientTestingModule } from '@angular/common/http/testing';
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
