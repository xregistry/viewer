import { Injectable, Inject, PLATFORM_ID } from '@angular/core';
import { HttpClient, HttpResponse } from '@angular/common/http';
// Removed PaginationInfo import as pagination now uses LinkSet and Page<T>
import { Observable, of, throwError, forkJoin, from, lastValueFrom, timer, defer } from 'rxjs';
import { map, switchMap, catchError, tap, retryWhen, take, concat, delay } from 'rxjs/operators';
import { Group, Resource, ResourceDocument } from '../models/registry.model';
import { ModelService } from './model.service';
import { ConfigService } from './config.service';
import { DebugService } from './debug.service';
import { isPlatformBrowser } from '@angular/common';
import { LRUCache } from '../utils/lru-cache';
// Removed duplicate import of HttpResponse

/**
 * Type to represent the key structure for API endpoint caching
 */
type ResourceKey = {
  groupType: string;
  groupId: string;
  resourceType: string;
  resourceId?: string;
};

/**
 * Retry configuration for API requests
 */
interface RetryConfig {
  maxRetries: number;
  baseDelay: number;
  maxDelay: number;
  backoffMultiplier: number;
}

// Define a Page<T> structure for paginated results
export interface Page<T> {
  items: T;
  links: {
    first?: string;
    prev?: string;
    next?: string;
    last?: string;
  };
  totalCount?: number;
  currentPage?: number;
  totalPages?: number;
  pageSize?: number;
  // Error handling fields for multi-API scenarios
  totalApis?: number;
  successfulApis?: number;
  failedApis?: number;
  error?: any;
  allApiErrors?: Array<{ api: string; error: any }>;
}

@Injectable({
  providedIn: 'root',
})
export class RegistryService {
  private servedFromServer: boolean;

  // LRU cache for successful API endpoints
  private endpointCache = new LRUCache<string, string>(1000);

  // Cache for document resources to avoid repeated fetches
  private resourceCache = new LRUCache<string, ResourceDocument>(100);

  // Default bounded page size for group listing requests (used unless a
  // caller explicitly requests a different, still-bounded size).
  private readonly defaultGroupPageSize = 50;

  // Request-sharing cache for group listing pages: dedupes identical
  // in-flight/completed requests (including adjacent-next-page prefetch) so
  // pagination and prefetch never issue duplicate network calls, and so
  // clicking "next" after a prefetch reuses the already-fetched page.
  private groupsPageCache = new LRUCache<string, Promise<Page<Group[]>>>(50);

  // Default retry configuration
  private defaultRetryConfig: RetryConfig = {
    maxRetries: 3,
    baseDelay: 1000, // 1 second
    maxDelay: 10000, // 10 seconds
    backoffMultiplier: 2
  };

  constructor(
    private http: HttpClient,
    private modelService: ModelService,
    private configService: ConfigService,
    private debug: DebugService,
    @Inject(PLATFORM_ID) private platformId: Object
  ) {
    // Compute the base URL for the app (from config or fallback to '/')
    const configBaseUrl = (this.configService.getConfig()?.baseUrl || '/').replace(/\/$/, '');
    function proxyUrl(path: string) {
      return `${configBaseUrl}/proxy${path}`;
    }
    // Disable proxy detection - always use direct API calls
    this.servedFromServer = false;

    // Subscribe to config changes to clear caches when endpoints change
    this.configService.configChanges$.subscribe(() => {
      console.log('RegistryService: Config changed, clearing caches');
      this.clearCache();
    });
  }

  /**
   * Clear all caches (called when configuration changes)
   */
  clearCache(): void {
    console.log('RegistryService: Clearing endpoint and resource caches');
    this.endpointCache.clear();
    this.resourceCache.clear();
    this.groupsPageCache.clear();
  }

  /**
   * Retry an observable with exponential backoff
   */
  private retryWithBackoff<T>(
    source: Observable<T>,
    config: Partial<RetryConfig> = {}
  ): Observable<T> {
    const finalConfig = { ...this.defaultRetryConfig, ...config };

    return source.pipe(
      retryWhen(errors =>
        errors.pipe(
          map((error, index) => ({ error, index })),
          switchMap(({ error, index }) => {
            const retryAttempt = index + 1;

            // If we've exceeded max retries, throw the error
            if (retryAttempt > finalConfig.maxRetries) {
              this.debug.error(`Max retries (${finalConfig.maxRetries}) exceeded`, error);
              return throwError(() => error);
            }

            // Calculate delay with exponential backoff
            const delay = Math.min(
              finalConfig.baseDelay * Math.pow(finalConfig.backoffMultiplier, index),
              finalConfig.maxDelay
            );

            this.debug.log(`Retry attempt ${retryAttempt}/${finalConfig.maxRetries} after ${delay}ms delay`);

            // Return a timer that emits after the calculated delay
            return timer(delay);
          })
        )
      )
    );
  }

  /**
   * Enhanced HTTP request with retry logic
   */
  private httpGetWithRetry<T>(
    url: string,
    options: any = {},
    retryConfig?: Partial<RetryConfig>
  ): Observable<HttpResponse<T>> {
    return this.retryWithBackoff(
      this.http.get<T>(url, { observe: 'response', ...options }).pipe(
        map(response => response as HttpResponse<T>)
      ),
      retryConfig
    );
  }

  /**
   * Gets the API endpoints from configuration
   */
  private getApiEndpoints(): string[] {
    const config = this.configService.getConfig();
    return config?.apiEndpoints || [];
  }

  /**
   * Generates a cache key for the resource
   */
  private getCacheKey(resourceKey: ResourceKey): string {
    const { groupType, groupId, resourceType, resourceId } = resourceKey;
    return `${groupType}|${groupId}|${resourceType}${resourceId ? '|' + resourceId : ''}`;
  }

  private buildPath(...segments: string[]): string {
    return `/${segments.map(segment => encodeURIComponent(segment)).join('/')}`;
  }

  /**
   * Constructs the API URL based on the resource path and whether we're using a proxy
   */
  private getApiUrl(api: string, path: string, filter?: string): string {
    let url = `${api}${path}`;

    // Add filter parameter if provided
    if (filter) {
      const separator = path.includes('?') ? '&' : '?';
      url += `${separator}filter=${encodeURIComponent(filter)}`;
    }

    // Always return direct URL for now since proxy configuration is not working
    return url;
  }

  /**
   * Add filter parameter to any URL (absolute or relative)
   */
  private addFilterToUrl(url: string, filter?: string): string {
    if (!filter) {
      return url;
    }

    try {
      const urlObj = new URL(url);
      urlObj.searchParams.set('filter', filter);
      return urlObj.toString();
    } catch (e) {
      // If URL parsing fails, fall back to simple string concatenation
      const separator = url.includes('?') ? '&' : '?';
      return `${url}${separator}filter=${encodeURIComponent(filter)}`;
    }
  }

  /**
   * List resources using RFC5988 relation-based navigation
   * @param groupType the group type
   * @param groupId the group id
   * @param resourceType the resource type
   * @param pageRel optional Link rel URL or path (first, prev, next, last or empty)
   * @param filter optional filter string to apply to the query
   */
  listResources(
    groupType: string,
    groupId: string,
    resourceType: string,
    pageRel: string = '',
    filter?: string
  ): Observable<Page<ResourceDocument[]>> {
    const pagePath = pageRel || this.buildPath(groupType, groupId, resourceType);
    return from(this.listResourcesAsync(groupType, groupId, resourceType, pagePath, filter));
  }

  /**
   * Async implementation of listResources with relation-based URL
   */
  private async listResourcesAsync(
    groupType: string,
    groupId: string,
    resourceType: string,
    pagePath: string,
    filter?: string
  ): Promise<Page<ResourceDocument[]>> {
    const model = await lastValueFrom(this.modelService.getRegistryModel());
    const apis = this.modelService.getApiEndpointsForGroupType(groupType);
    if (apis.length === 0) {
      return { items: [], links: {} };
    }

    // Track 404 errors to distinguish between "resource not found" vs other failures
    let allEndpoints404 = true;
    let lastError: any = null;
    let lastNon404Error: any = null;

    // Try each API endpoint until we find one that works
    for (const api of apis) {
      try {
        this.debug.log(`Processing API: ${api}, pagePath: "${pagePath}", starts with http: ${pagePath.startsWith('http')}`);

        let url: string;
        if (pagePath.startsWith('http')) {
          // For absolute URLs (pagination links), add filter directly
          url = this.addFilterToUrl(pagePath, filter);
        } else {
          // For relative URLs, use getApiUrl which handles filter internally
          url = this.getApiUrl(api, pagePath, filter);
        }

        this.debug.log(`Filter applied: "${filter}", Final URL: ${url}`);

        this.debug.log(`Requesting resources from: ${url}`);
        const response = await lastValueFrom(
          this.httpGetWithRetry<{ [key: string]: any }>(url)
        );
        const data = response.body || {};

        // Parse Link header into links and metadata
        const links: any = {};
        let totalCount: number | undefined;
        let pageSize: number | undefined;
        const linkHeader = response.headers.get('Link') || '';

        if (linkHeader) {
          this.debug.log(`Parsing Link header: ${linkHeader}`);
          // Split by comma and process each part
          linkHeader.split(',').forEach((part, index) => {
            const trimmedPart = part.trim();
            this.debug.log(`  Part ${index}: "${trimmedPart}"`);

            // Format: <url>; rel="relation" (standard RFC 5988)
            const linkMatch = trimmedPart.match(/<([^>]+)>;\s*rel="?([a-zA-Z0-9_-]+)"?/i);
            if (linkMatch) {
              const url = linkMatch[1];
              const rel = linkMatch[2].toLowerCase(); // Normalize to lowercase
              links[rel] = url;
              this.debug.log(`    Matched link: ${rel} -> ${url}`);
              return; // Continue to next part
            }

            // Format: key="value" (standalone metadata fields like count="640302", per-page="50")
            const metaMatch = trimmedPart.match(/^([a-zA-Z0-9_-]+)="?([^"]+)"?$/i);
            if (metaMatch) {
              const key = metaMatch[1].toLowerCase();
              const value = metaMatch[2].replace(/"/g, '');

              // Extract count and per-page information
              if (key === 'count') {
                totalCount = parseInt(value, 10);
                this.debug.log(`    Found total count: ${totalCount}`);
              } else if (key === 'per-page') {
                pageSize = parseInt(value, 10);
                this.debug.log(`    Found page size: ${pageSize}`);
              }

              // Store metadata with the same format as links for backward compatibility
              links[key] = value;
              this.debug.log(`    Matched metadata: ${key} = ${value}`);
              return; // Continue to next part
            }

            this.debug.warn(`    Could not parse Link header part: "${trimmedPart}"`);
          });

          this.debug.log(`Final parsed links object:`, links);
        }

        // Map entries to ResourceDocument[]
        const resMeta = model.groups[groupType]?.resources?.[resourceType] || { singular: resourceType, attributes: {} };
        const attrs = resMeta.attributes || {};
        this.debug.log('Original data entries:', data);

        const items: ResourceDocument[] = Object.values(data).map((entry: any) => {
          const idKey = resMeta.singular + 'id';

          // First, clone the entry to preserve all original fields
          const doc: any = { ...entry };

          // Then override with the properly cased and mapped fields
          doc.id = entry[idKey] || entry.id || entry.name; // Fallback to name if id is missing
          doc.name = entry.name || entry[idKey] || entry.id; // Fallback to id if name is missing
          doc.description = entry.description;

                  // Explicitly map documentation to resourceUrl for the resource-row component
        if (entry.documentation) {
          doc.resourceUrl = entry.documentation;
          doc.documentation = entry.documentation; // Make sure both are set
        }

          // Ensure proper case for timestamp fields
          doc.createdAt = entry.createdat || entry.createdAt;
          doc.modifiedAt = entry.modifiedat || entry.modifiedAt;
          doc.origin = api;

          // Add attributes from the registry model
          Object.keys(attrs).forEach(key => {
            if (!['id', 'name', idKey].includes(key) && entry[key] != null) {
              doc[key] = entry[key];
            }
          });

          // Log the mapped document for debugging
          this.debug.log('Mapped resource:', doc);

          return doc as ResourceDocument;
        });

        // Calculate current page if possible
        let currentPage: number | undefined;
        if (pageSize && links.next) {
          try {
            const nextUrl = new URL(links.next);
            const nextOffset = parseInt(nextUrl.searchParams.get('offset') || '0', 10);
            currentPage = Math.floor(nextOffset / pageSize);
          } catch (e) {
            this.debug.warn('Could not parse current page from next link:', e);
          }
        }

        this.debug.log(`Returning page with ${items.length} items, totalCount: ${totalCount}, pageSize: ${pageSize}, currentPage: ${currentPage}`);
        return { items, links, totalCount, pageSize, currentPage };
      } catch (err) {
        this.debug.error(`Failed to list resources from ${api}:`, err);
        lastError = err;

        // Check if this was a 404 error
        if (err && typeof err === 'object' && 'status' in err && err.status !== 404) {
          allEndpoints404 = false;
          lastNon404Error = err;
        }

        continue;
      }
    }

    // If all endpoints returned 404, this means the resource path doesn't exist
    if (allEndpoints404 && lastError) {
      this.debug.error('All endpoints returned 404 - resource path does not exist');
      throw {
        ...lastError,
        status: 404,
        message: `Resource path "${pagePath}" not found`,
        isResourceNotFound: true
      };
    }

    this.debug.error('All APIs failed to load resources');
    throw lastNon404Error ?? lastError ?? new Error('All registry endpoints failed to load resources');
  }

  getGroup(groupType: string, groupId: string): Observable<Group> {
    return from(this.getGroupAsync(groupType, groupId));
  }

  /**
   * Async implementation of getGroup
   */
  private async getGroupAsync(groupType: string, groupId: string): Promise<Group> {
    // Check cache for successful endpoint
    const cacheKey = this.getCacheKey({
      groupType,
      groupId,
      resourceType: '*'
    });
    const cachedApi = this.endpointCache.get(cacheKey);    // Get all APIs to try
    const apis = this.modelService.getApiEndpointsForGroupType(groupType);
    if (apis.length === 0) return null as any;

    // If we have a cached API, try it first
    const apisToTry = cachedApi
      ? [cachedApi, ...apis.filter(a => a !== cachedApi)]
      : apis;

    // Try each API until we find one that works
    for (const api of apisToTry) {
      try {
        const url = this.getApiUrl(api, this.buildPath(groupType, groupId));
        const group = await lastValueFrom(
          this.httpGetWithRetry<Group>(url).pipe(
            map(response => response.body as Group)
          )
        );

        const result = { ...group, origin: api };

        // Cache successful endpoint
        this.endpointCache.set(cacheKey, api);

        return result;
      } catch (err) {
        continue;
      }
    }

    return null as any;
  }
  getResource(
    groupType: string,
    groupId: string,
    resourceType: string,
    resourceId: string
  ): Observable<ResourceDocument> {
    return from(this.getResourceAsync(
      groupType,
      groupId,
      resourceType,
      resourceId
    ));
  }

  /**
   * Async implementation of getResource
   */
  private async getResourceAsync(
    groupType: string,
    groupId: string,
    resourceType: string,
    resourceId: string
  ): Promise<ResourceDocument> {
    const model = await lastValueFrom(this.modelService.getRegistryModel());
    const resourceMeta = model.groups[groupType]?.resources?.[resourceType];

    if (!resourceMeta) {
      this.debug.error(
        `Resource type ${resourceType} not found in group type ${groupType}`
      );
      throw new Error(
        `Resource type ${resourceType} not found in group type ${groupType}`
      );
    }

    // Determine if this resource type has document support (defaults to true per xRegistry spec)
    const hasDocument = resourceMeta.hasdocument !== false;

    // Get resource details
    return this.getResourceDetailAsync(
      groupType,
      groupId,
      resourceType,
      resourceId,
      hasDocument
    );
  }
  getVersionDetail(
    groupType: string,
    groupId: string,
    resourceType: string,
    resourceId: string,
    versionId: string,
    hasDocument: boolean,
    origin?: string // use origin if provided
  ): Observable<ResourceDocument> {
    return from(this.getVersionDetailAsync(
      groupType,
      groupId,
      resourceType,
      resourceId,
      versionId,
      hasDocument,
      origin
    ));
  }

  /**
   * Async implementation of getVersionDetail
   */
  private async getVersionDetailAsync(
    groupType: string,
    groupId: string,
    resourceType: string,
    resourceId: string,
    versionId: string,
    hasDocument: boolean,
    origin?: string
  ): Promise<ResourceDocument> {
    // Check resource cache first
    const cacheKey = this.getCacheKey({
      groupType,
      groupId,
      resourceType,
      resourceId: `${resourceId}/versions/${versionId}`
    });

    const cachedResource = this.resourceCache.get(cacheKey);
    if (cachedResource) {
      return cachedResource;
    }

    // Get the resource details using common method
    const resource = await this.fetchResourceDetailsAsync({
      groupType,
      groupId,
      resourceType,
      resourceId,
      versionId,
      hasDocument,
      origin
    });

    // Cache the result
    if (resource) {
      this.resourceCache.set(cacheKey, resource);
    }

    return resource;
  }
  getResourceDetail(
    groupType: string,
    groupId: string,
    resourceType: string,
    resourceId: string,
    hasDocument: boolean,
    origin?: string // use origin if provided
  ): Observable<ResourceDocument> {
    // Use defer() to delay Promise creation until subscription
    // This ensures the Promise doesn't start executing before the async pipe subscribes
    return defer(() => from(this.getResourceDetailAsync(
      groupType,
      groupId,
      resourceType,
      resourceId,
      hasDocument,
      origin
    )));
  }

  /**
   * Async implementation of getResourceDetail
   */
  private async getResourceDetailAsync(
    groupType: string,
    groupId: string,
    resourceType: string,
    resourceId: string,
    hasDocument: boolean,
    origin?: string
  ): Promise<ResourceDocument> {
    console.log(`RegistryService: getResourceDetailAsync called for ${groupId}/${resourceId}`);

    // Check resource cache first
    const cacheKey = this.getCacheKey({
      groupType,
      groupId,
      resourceType,
      resourceId
    });

    const cachedResource = this.resourceCache.get(cacheKey);
    if (cachedResource) {
      console.log(`RegistryService: Returning cached resource for ${resourceId}`);
      return cachedResource;
    }

    console.log(`RegistryService: Fetching resource ${resourceId} from API`);
    // Get the resource details using common method
    const resource = await this.fetchResourceDetailsAsync({
      groupType,
      groupId,
      resourceType,
      resourceId,
      hasDocument,
      origin
    });

    // Cache the result
    if (resource) {
      console.log(`RegistryService: Caching resource ${resourceId}`);
      this.resourceCache.set(cacheKey, resource);
    } else {
      console.warn(`RegistryService: Resource ${resourceId} returned null`);
    }

    return resource;
  }
  /**
   * List resource version history using RFC5988 relation-based navigation
   * @param groupType the group type
   * @param groupId the group id
   * @param resourceType the resource type
   * @param resourceId the resource id
   * @param pageRel optional Link rel URL or path (first, prev, next, last or empty)
   * @param filter optional filter string to apply to the query
   */
  getResourceVersions(
    groupType: string,
    groupId: string,
    resourceType: string,
    resourceId: string,
    pageRel: string = '',
    filter?: string
  ): Observable<Page<ResourceDocument[]>> {
    const pagePath = pageRel ||
      `${this.buildPath(groupType, groupId, resourceType, resourceId)}/versions`;
    return from(
      this.listResourceVersionsAsync(
        groupType,
        groupId,
        resourceType,
        resourceId,
        pagePath,
        filter
      )
    );
  }
  private async listResourceVersionsAsync(
    groupType: string,
    groupId: string,
    resourceType: string,
    resourceId: string,
    pagePath: string,
    filter?: string
  ): Promise<Page<ResourceDocument[]>> {
    const model = await lastValueFrom(this.modelService.getRegistryModel());
    const apis = this.modelService.getApiEndpointsForGroupType(groupType);
    if (apis.length === 0) {
      return { items: [], links: {} };
    }

    let lastError: any = null;
    let lastNon404Error: any = null;

    // Try each API endpoint until we find one that works
    for (const api of apis) {
      try {
        let url = pagePath.startsWith('http') ? pagePath : this.getApiUrl(api, pagePath);

        // Always add filter to the URL, whether it's absolute or relative
        url = this.addFilterToUrl(url, filter);

        this.debug.log(`Requesting versions from: ${url}`);
        const response = await lastValueFrom(
          this.httpGetWithRetry<any>(url)
        );
        const data = response.body || {};

        // Parse Link header into relations with improved regex
        const linkHeader = response.headers.get('Link') || '';
        this.debug.log(`Link header received for versions: ${linkHeader}`);

        const links: any = {};
        // Split by comma and process each part
        linkHeader.split(',').forEach(part => {
          const trimmedPart = part.trim();

          // Format: <url>; rel="relation" (standard RFC 5988)
          const linkMatch = trimmedPart.match(/<([^>]+)>;\s*rel="?([a-zA-Z0-9_-]+)"?/i);
          if (linkMatch) {
            const url = linkMatch[1];
            const rel = linkMatch[2].toLowerCase(); // Normalize to lowercase
            links[rel] = url;
            this.debug.log(`Found version link relation: ${rel} -> ${url}`);
            return; // Continue to next part
          }

          // Format: key="value" (metadata fields)
          const metaMatch = trimmedPart.match(/([a-zA-Z0-9_-]+)="?([^"]+)"?/i);
          if (metaMatch) {
            const key = metaMatch[1].toLowerCase();
            const value = metaMatch[2].replace(/"/g, '');
            // Store metadata with the same format as links
            links[key] = value;
            this.debug.log(`Found version metadata: ${key} -> ${value}`);
            return; // Continue to next part
          }
          // If we reach here, we couldn't parse this part
          this.debug.log(`Skipping version Link header part (not a link or metadata): ${trimmedPart}`);
        });
        // Map entries to ResourceDocument[]
        const resMeta = model.groups[groupType]?.resources?.[resourceType] || { singular: resourceType, attributes: {} };
        const attrs = resMeta.attributes || {};
        const items: ResourceDocument[] = Object.values(data).map((entry: any) => {
          const idKey = resMeta.singular + 'id';
          const doc: any = {
            id: entry[idKey] || entry.id,
            name: entry.name,
            createdAt: entry.createdat,
            modifiedAt: entry.modifiedat,
            origin: api,
            ...entry
          };
          Object.keys(attrs).forEach(key => {
            if (!['id', 'name', idKey].includes(key) && entry[key] != null) {
              doc[key] = entry[key];
            }
          });
          return doc as ResourceDocument;
        });
        return { items, links };
      } catch (err) {
        this.debug.error(`Failed to list resource versions from ${api}:`, err);
        lastError = err;
        if (err && typeof err === 'object' && 'status' in err && err.status !== 404) {
          lastNon404Error = err;
        }
        continue;
      }
    }

    throw lastNon404Error ?? lastError ?? new Error('All registry endpoints failed to load version history');
  }

  fetchDocument(url: string): Observable<string> {
    // In SSR environment, return empty observable to avoid HTTP requests
    if (this.servedFromServer) {
      return of('');
    }

    return this.retryWithBackoff(
      this.http.get(url, { responseType: 'text' })
    ).pipe(
      catchError((error) => {
        this.debug.error(`Error fetching document from ${url}:`, error);
        return throwError(() => error);
      })
    );
  }
  /**
   * Gets the singular name for a resource type from the cached model
   * @param resourceType The resource type to get the singular name for
   * @returns The singular name for the resource type or a fallback if not found
   */
  private getSingularNameFromModel(resourceType: string): string {
    // Try to get the singular name from the cached model
    const model = (this.modelService as any).cachedModel;

    if (model && model.groups) {
      // Look through all groups to find the resource type
      for (const groupTypeKey in model.groups) {
        const groupType = model.groups[groupTypeKey];
        if (groupType.resources && groupType.resources[resourceType]) {
          return groupType.resources[resourceType].singular;
        }
      }
    }

    // Fallback: Use a reasonable guess if the model doesn't have it
    this.debug.warn(
      `Could not find singular name for ${resourceType} in cached model, using fallback`
    );
    return resourceType.endsWith('s')
      ? resourceType.slice(0, -1)
      : resourceType;
  }

  /**
   * Common method to process document fields from a response
   * @param response The API response object
   * @param resourceType The type of resource (used to determine the singular name)
   * @param hasDocument Whether to look for document fields
   * @returns Processed ResourceDocument with standardized document fields
   */  /**
   * Process API response to standardize resource objects
   */
  private processResourceResponse(
    entry: any,
    resMeta: any,
    api: string,
    hasDocument: boolean
  ): ResourceDocument {
    if (!entry) return null as any;

    const singularKey = resMeta.singular + 'id';
    const attrs = resMeta.attributes || {};

    const selectedName = entry.name || entry.title || entry[singularKey] || entry.id;

    const resource: any = {
      id: entry[singularKey] || entry.id,
      name: selectedName,
      description: entry.description,
      createdAt: entry.createdat,
      modifiedAt: entry.modifiedat,
      origin: api
    };

    // Include version-related information
    if (entry.versionscount != null) resource.versionscount = entry.versionscount;
    if (entry.versionsurl != null) resource.versionsurl = entry.versionsurl;
    if (entry.meta?.defaultversionid != null) resource.defaultversionid = entry.meta.defaultversionid;

    // Include counts and URLs
    Object.keys(entry).forEach(key => {
      if ((key.endsWith('count') || key.endsWith('url')) && entry[key] != null) {
        resource[key] = entry[key];
      }
    });

    // Include metadata attributes
    if (entry.meta) {
      Object.keys(entry.meta).forEach(key => {
        if (resource[key] === undefined) {
          resource[key] = entry.meta[key];
        }
      });
    }

    // Include other attributes from model metadata
    Object.keys(attrs).forEach(key => {
      if ([singularKey, 'id', 'name', 'description'].includes(key)) return;
      if (entry[key] != null) resource[key] = entry[key];
    });

    // Copy any remaining properties
    Object.keys(entry).forEach(key => {
      if (
        ![
          'id',
          'name',
          'description',
          'createdat',
          'modifiedat',
          'meta',
        ].includes(key) &&
        resource[key] === undefined
      ) {
        resource[key] = entry[key];
      }
    });

    // Process document fields
    if (hasDocument) {
      return this.processDocumentFields(resource, resMeta.singular, hasDocument);
    }

    return resource as ResourceDocument;
  }

  private processDocumentFields(
    response: any,
    resourceType: string,
    hasDocument: boolean
  ): ResourceDocument {
    // Convert the response to ensure all properties are included
    const result: any = { ...response };

    // If hasDocument is true, look for document fields
    if (hasDocument) {
      // Get the singular name from the model directly
      const singularName = this.getSingularNameFromModel(resourceType);

      // Check if we have any document-related fields
      const hasSpecificDocument = !!(
        response[singularName] ||
        response[`${singularName}url`] ||
        response[`${singularName}base64`]
      );

      if (hasSpecificDocument) {
        // If the document is in a specific field, standardize to our common field names
        if (response[singularName]) {
          result.resource = response[singularName];
        } else if (response[`${singularName}url`]) {
          result.resourceUrl = response[`${singularName}url`];
        } else if (response[`${singularName}base64`]) {
          result.resourceBase64 = response[`${singularName}base64`];
        }
      }
    }

    return result as ResourceDocument;
  }

  /**
   * Loads the default version for a resource
   * This is useful since a resource's content is essentially the content of its default version
   */  getResourceDefaultVersion(
    groupType: string,
    groupId: string,
    resourceType: string,
    resourceId: string,
    hasDocument: boolean
  ): Observable<ResourceDocument> {
    return from(this.getResourceDefaultVersionAsync(
      groupType,
      groupId,
      resourceType,
      resourceId,
      hasDocument
    ));
  }

  /**
   * Async implementation of getResourceDefaultVersion
   */
  private async getResourceDefaultVersionAsync(
    groupType: string,
    groupId: string,
    resourceType: string,
    resourceId: string,
    hasDocument: boolean
  ): Promise<ResourceDocument> {
    // First get the resource to find the default version ID
    const resource = await lastValueFrom(
      this.getResource(groupType, groupId, resourceType, resourceId)
    );
      if (resource['defaultversionid']) {
      // If there's a default version, fetch its details
      return await this.getVersionDetailAsync(
        groupType,
        groupId,
        resourceType,
        resourceId,
        resource['defaultversionid'],
        hasDocument,
        resource.origin
      );
    } else if (resource['versionscount'] && resource['versionscount'] > 0) {
      // If there are versions but no default specified, fetch first page of versions
      const page = await this.listResourceVersionsAsync(
        groupType,
        groupId,
        resourceType,
        resourceId,
        '' // initial pageRel to use default versions path
      );
      const versions = page.items;
      if (versions.length > 0) {
        // Assume first version is default if not specified
        const firstVersion = versions[0];
        const versionId = firstVersion.versionId || firstVersion.id;
        return await this.getVersionDetailAsync(
          groupType,
          groupId,
          resourceType,
          resourceId,
          versionId,
          hasDocument,
          resource.origin
        );
      }
    }

    // No versions available, return the resource itself
    return resource;
  }

  resolveDocument(
    url: string,
    response: any,
    resourceType: string
  ): ResourceDocument {
    // In SSR environment, return response synchronously without HTTP requests
    if (this.servedFromServer) {
      return response as ResourceDocument;
    }

    try {
      const xhr = new XMLHttpRequest();
      // Open a synchronous GET request
      xhr.open('GET', url, false);
      xhr.send(null);

      if (xhr.status === 200) {
        let parsed: any;

        try {
          // Try to parse the response as JSON
          parsed = JSON.parse(xhr.responseText);
        } catch (parseError) {
          // If it is not JSON, set resourceUrl to the URL and return
          response['resourceUrl'] = url;
          return response as ResourceDocument;
        }

        // Get the singular name from the model instead of iterating the JSON keys
        const singularName = this.getSingularNameFromModel(resourceType);

        if (parsed.hasOwnProperty(singularName + 'id')) {
          // Map specific document fields using the singular name from the model
          if (parsed.hasOwnProperty(singularName)) {
            response['resource'] = parsed[singularName];
          }
          if (parsed.hasOwnProperty(singularName + 'url')) {
            response['resourceUrl'] = parsed[singularName + 'url'];
          }
          if (parsed.hasOwnProperty(singularName + 'base64')) {
            response['resourceBase64'] = parsed[singularName + 'base64'];
          }
        } else {
          // If JSON but does not have the specific singular id field, set 'resource' to the parsed result
          response['resource'] = parsed;
        }
      } else {
        this.debug.error(`Error fetching document from ${url}: Status ${xhr.status}`);
        response['resourceUrl'] = url;
      }
    } catch (error) {
      this.debug.error(`Error fetching document from ${url}:`, error);
      response['resourceUrl'] = url;
    }

    return response as ResourceDocument;
  }

  /**
   * Async version of resolveDocument
   */
  private async resolveDocumentAsync(
    url: string,
    response: any,
    resourceType: string
  ): Promise<ResourceDocument> {
    // In SSR environment, return response synchronously without HTTP requests
    if (this.servedFromServer) {
      return response as ResourceDocument;
    }

    try {
      // Use fetch instead of XMLHttpRequest for better async support
      const result = await fetch(url);

      if (result.ok) {
        let parsed: any;

        try {
          // Try to parse the response as JSON
          parsed = await result.json();
        } catch (parseError) {
          // If it is not JSON, set resourceUrl to the URL and return
          response.resourceUrl = url;
          return response as ResourceDocument;
        }

        // Get the singular name from the model
        const singularName = this.getSingularNameFromModel(resourceType);

        if (parsed.hasOwnProperty(singularName + 'id')) {
          // Map specific document fields using the singular name
          if (parsed.hasOwnProperty(singularName)) {
            response.resource = parsed[singularName];
          }
          if (parsed.hasOwnProperty(singularName + 'url')) {
            response.resourceUrl = parsed[singularName + 'url'];
          }
          if (parsed.hasOwnProperty(singularName + 'base64')) {
            response.resourceBase64 = parsed[singularName + 'base64'];
          }
        } else {
          // If JSON but does not have the specific singular id field
          response.resource = parsed;
        }
      } else {
        this.debug.error(`Error fetching document from ${url}: Status ${result.status}`);
        response.resourceUrl = url;
      }
    } catch (error) {
      this.debug.error(`Error fetching document from ${url}:`, error);
      response.resourceUrl = url;
    }

    return response as ResourceDocument;
  }

  /**
   * Shared method to fetch resource details for both resources and versions
   */
  private async fetchResourceDetailsAsync({
    groupType,
    groupId,
    resourceType,
    resourceId,
    versionId,
    hasDocument,
    origin
  }: {
    groupType: string;
    groupId: string;
    resourceType: string;
    resourceId: string;
    versionId?: string;
    hasDocument: boolean;
    origin?: string;
  }): Promise<ResourceDocument> {
    const model = await lastValueFrom(this.modelService.getRegistryModel());

    // Check if we have a cached successful endpoint for this resource
    const endpointCacheKey = this.getCacheKey({
      groupType,
      groupId,
      resourceType,
      resourceId: versionId ? `${resourceId}/versions/${versionId}` : resourceId
    });
    const cachedApi = this.endpointCache.get(endpointCacheKey);    // Get APIs to try (use origin if provided, otherwise all endpoints)
    const apis = origin ? [origin] : this.modelService.getApiEndpointsForGroupType(groupType);
    if (apis.length === 0) return null as any;

    // If we have a cached API, try it first (unless origin is specified)
    const apisToTry = !origin && cachedApi
      ? [cachedApi, ...apis.filter(a => a !== cachedApi)]
      : apis;

    const resMeta = model.groups[groupType]?.resources?.[resourceType] ||
      { singular: resourceType, attributes: {}, hasdocument: false };

    // Track 404 errors to distinguish between "not found" vs other failures
    let allEndpoints404 = true;
    let lastError: any = null;
    let lastNon404Error: any = null;

    // Try each API endpoint until we get a successful response
    for (const api of apisToTry) {
      try {
        // Construct base path depending on whether this is for a version or resource
        let basePath = this.buildPath(groupType, groupId, resourceType, resourceId);
        if (versionId) {
          basePath += `/versions/${encodeURIComponent(versionId)}`;
        }

        // Construct URLs for regular and $details endpoints
        const regularUrl = this.getApiUrl(api, basePath);
        const detailsUrl = this.getApiUrl(api, `${basePath}$details`);

        // Choose primary URL based on document support
        const primaryUrl = hasDocument ? detailsUrl : regularUrl;

        // Try the primary URL first
        try {
          const entry = await lastValueFrom(
            this.httpGetWithRetry<any>(primaryUrl).pipe(
              map(response => response.body)
            )
          );

          // Process the response
          const resource = this.processResourceResponse(entry, resMeta, api, hasDocument);

          // Cache the successful API endpoint
          this.endpointCache.set(endpointCacheKey, api);

          // Resolve document if needed
          if (hasDocument &&
              !resource.resource &&
              !resource.resourceUrl &&
              !resource.resourceBase64) {
            await this.resolveDocumentAsync(regularUrl, resource, resourceType);
          }

          return resource;
        } catch (error) {          // If $details URL failed with 404, try the regular URL
          if (hasDocument && error && typeof error === 'object' && 'status' in error && error.status === 404) {
            try {
              const entry = await lastValueFrom(
                this.httpGetWithRetry<any>(regularUrl).pipe(
                  map(response => response.body)
                )
              );

              // Process the response
              const resource = this.processResourceResponse(entry, resMeta, api, hasDocument);

              // Cache the successful API endpoint
              this.endpointCache.set(endpointCacheKey, api);

              // Resolve document if needed
              if (hasDocument &&
                  !resource.resource &&
                  !resource.resourceUrl &&
                  !resource.resourceBase64) {
                await this.resolveDocumentAsync(regularUrl, resource, resourceType);
              }

              return resource;
            } catch (regularError) {
              // If regular URL also failed, track the error
              lastError = regularError;
              if (regularError && typeof regularError === 'object' && 'status' in regularError && regularError.status !== 404) {
                allEndpoints404 = false;
                lastNon404Error = regularError;
              }
              throw regularError;
            }
          }

          // For other errors, track them and re-throw
          lastError = error;
          if (error && typeof error === 'object' && 'status' in error && error.status !== 404) {
            allEndpoints404 = false;
            lastNon404Error = error;
          }
          throw error;
        }
      } catch (err) {
        this.debug.error(`Failed to get resource details from ${api}:`, err);
        lastError = err;

        // Check if this was a 404 error
        if (err && typeof err === 'object' && 'status' in err && err.status !== 404) {
          allEndpoints404 = false;
          lastNon404Error = err;
        }

        continue;
      }
    }

    // If all endpoints returned 404, throw appropriate "not found" error
    if (allEndpoints404 && lastError) {
      this.debug.error(`All endpoints returned 404 - ${versionId ? 'version' : 'resource'} does not exist`);
      const notFoundMessage = versionId
        ? `Version "${versionId}" not found for resource "${resourceId}"`
        : `Resource "${resourceId}" not found`;

      throw {
        ...lastError,
        status: 404,
        message: notFoundMessage,
        isResourceNotFound: !versionId, // true for resources, false for versions
        isVersionNotFound: !!versionId  // true for versions, false for resources
      };
    }

    this.debug.error('All APIs failed to load resource details');
    throw lastNon404Error ?? lastError ?? new Error('All registry endpoints failed to load resource details');
  }

  /**
   * Parse RFC5988 Link header into pagination info
   */
  private parseLinkHeader(header: string, pageSize: number) {
    let totalCount: number | undefined;
    let totalPages = 1;
    let currentPage = 1;
    const links = header.split(',').map(part => part.trim());
    const rels: any = {};
    links.forEach(link => {
      const match = link.match(/<([^>]+)>;\s*rel="?(\w+)"?(?:;count=(\d+))?/);
      if (match) {
        const url = match[1];
        const rel = match[2];
        const count = match[3] ? parseInt(match[3], 10) : undefined;
        rels[rel] = { url, count };
        if (count !== undefined) {
          totalCount = count;
        }
      }
    });
    if (totalCount !== undefined) {
      totalPages = Math.ceil(totalCount / pageSize);
    } else if (rels['last'] && rels['last'].url) {
      const params = new URL(rels['last'].url).searchParams;
      const offset = parseInt(params.get('offset') || '0', 10);
      totalPages = Math.floor(offset / pageSize) + 1;
    }
    if (rels['next']) {
      const params = new URL(rels['next'].url).searchParams;
      const nextOffset = parseInt(params.get('offset') || '0', 10);
      currentPage = Math.floor(nextOffset / pageSize);
    } else if (rels['prev']) {
      const params = new URL(rels['prev'].url).searchParams;
      const prevOffset = parseInt(params.get('offset') || '0', 10);
      currentPage = Math.floor(prevOffset / pageSize) + 2;
    }
    return { currentPage, totalPages, pageSize, totalCount };
  }

  /**
   * Parse an RFC5988 Link header into a relation -> absolute URL map.
   * Shared by both single-origin and per-origin (multi-API) group listing so a
   * single API's real Link relations are always retained and used as-is.
   */
  private parseGroupLinkHeader(linkHeader: string): { [rel: string]: string } {
    const links: { [rel: string]: string } = {};
    if (!linkHeader) {
      return links;
    }
    linkHeader.split(',').forEach(part => {
      const trimmed = part.trim();
      if (!trimmed) {
        return;
      }
      const match = trimmed.match(/<([^>]+)>;\s*rel="?([a-zA-Z0-9_-]+)"?/i);
      if (match) {
        links[match[2]] = match[1];
        this.debug.log(`Found link relation: ${match[2]} -> ${match[1]}`);
      } else {
        this.debug.warn(`Failed to parse link header part: ${trimmed}`);
      }
    });
    return links;
  }

  /**
   * Parse the `X-Total-Count` response header - now exposed cross-origin via
   * `Access-Control-Expose-Headers` - into a total-item count for a group
   * listing response. This is only ever read from a SINGLE contributing
   * origin's own response (the initial single-origin request, or an
   * absolute-URL pagination continuation for a single origin); a merged
   * multi-origin listing has no single coherent total and intentionally
   * leaves `totalCount` undefined rather than guessing (e.g. by summing
   * origins), since that was not requested and could silently mislead users
   * about how paging maps onto a genuinely merged, multi-origin collection.
   */
  private parseGroupTotalCount(response: HttpResponse<any>): number | undefined {
    const raw = response.headers.get('X-Total-Count');
    if (!raw) {
      return undefined;
    }
    const parsed = parseInt(raw, 10);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  /**
   * Derive `currentPage` / `totalPages` for a single-origin group listing
   * page from its bounded page size, its (optional) total item count, and
   * the RFC5988 Link relations returned alongside it. Mirrors the existing,
   * already-proven derivation used for resource listings so behavior stays
   * consistent across the app wherever these optional `Page<T>` fields are
   * available to a consumer.
   */
  private deriveGroupPageMeta(
    pageSize: number,
    totalCount: number | undefined,
    links: { [rel: string]: string }
  ): { currentPage?: number; totalPages?: number } {
    let currentPage: number | undefined;
    if (links['next']) {
      try {
        const nextOffset = parseInt(new URL(links['next']).searchParams.get('offset') || '0', 10);
        currentPage = Math.floor(nextOffset / pageSize);
      } catch {
        // Malformed/relative next URL - leave currentPage undetermined rather than guessing.
      }
    } else if (links['prev']) {
      try {
        const prevOffset = parseInt(new URL(links['prev']).searchParams.get('offset') || '0', 10);
        currentPage = Math.floor(prevOffset / pageSize) + 2;
      } catch {
        // Malformed/relative prev URL - leave currentPage undetermined rather than guessing.
      }
    } else {
      currentPage = 1;
    }

    let totalPages: number | undefined;
    if (totalCount !== undefined && pageSize > 0) {
      totalPages = Math.ceil(totalCount / pageSize);
    } else if (links['last']) {
      try {
        const lastOffset = parseInt(new URL(links['last']).searchParams.get('offset') || '0', 10);
        totalPages = Math.floor(lastOffset / pageSize) + 1;
      } catch {
        // Malformed/relative last URL - leave totalPages undetermined rather than guessing.
      }
    }

    return { currentPage, totalPages };
  }

  /** Prefix identifying an opaque, bounded multi-origin pagination cursor. */
  private static readonly MULTI_ORIGIN_CURSOR_PREFIX = 'multi:';

  /**
   * Encode a set of per-origin absolute Link URLs (e.g. every origin's own
   * "next" relation) PLUS a `previous` breadcrumb into a single opaque cursor
   * string. This lets a merged, multi-API group listing represent paging
   * coherently through the exact same `Page<T>.links` shape used for a
   * single API, instead of silently discarding pagination once more than one
   * origin contributes.
   *
   * The `previous` breadcrumb is the cursor (or the initial `/<groupType>`
   * path) that was used to fetch the CURRENT page. It is carried FORWARD
   * into every subsequently-issued `next` cursor. This is required because
   * once an origin is exhausted (has no more `next` relation of its own) it
   * is correctly dropped from `origins` on later pages - so there is no
   * general way to reconstruct a prior merged page's per-origin URLs from a
   * later page's per-origin URLs alone. Storing the exact previous cursor
   * instead lets `links.prev` simply replay that earlier, already-known
   * request deterministically, rather than trying (and failing) to recompose
   * it from currently-active origins only.
   */
  private encodeMultiOriginCursor(origins: { [api: string]: string }, previous: string): string | undefined {
    const entries = Object.entries(origins).filter(([, url]) => !!url);
    if (entries.length === 0) {
      return undefined;
    }
    const payload = JSON.stringify({ origins: Object.fromEntries(entries), previous });
    return `${RegistryService.MULTI_ORIGIN_CURSOR_PREFIX}${encodeURIComponent(payload)}`;
  }

  private decodeMultiOriginCursor(cursor: string): { origins: { [api: string]: string }; previous: string } {
    const encoded = cursor.slice(RegistryService.MULTI_ORIGIN_CURSOR_PREFIX.length);
    try {
      const decoded = JSON.parse(decodeURIComponent(encoded));
      if (decoded && typeof decoded === 'object' && decoded.origins && typeof decoded.origins === 'object') {
        return {
          origins: decoded.origins,
          previous: typeof decoded.previous === 'string' ? decoded.previous : ''
        };
      }
      return { origins: {}, previous: '' };
    } catch (err) {
      this.debug.error(`Failed to decode multi-origin pagination cursor: ${cursor}`, err);
      return { origins: {}, previous: '' };
    }
  }

  private isMultiOriginCursor(pagePath: string): boolean {
    return pagePath.startsWith(RegistryService.MULTI_ORIGIN_CURSOR_PREFIX);
  }

  /**
   * Ensure a URL carries an explicit, bounded page size (`limit`) so an
   * initial group listing request can never turn into an unbounded fetch.
   * Absolute pagination URLs taken straight from a server's own Link header
   * already encode the server-chosen limit/offset and are left untouched.
   */
  private withBoundedLimit(url: string, pageSize: number): string {
    try {
      const urlObj = new URL(url);
      if (!urlObj.searchParams.has('limit')) {
        urlObj.searchParams.set('limit', String(pageSize));
      }
      return urlObj.toString();
    } catch {
      if (/[?&]limit=/.test(url)) {
        return url;
      }
      const separator = url.includes('?') ? '&' : '?';
      return `${url}${separator}limit=${pageSize}`;
    }
  }

  /**
   * List groups using RFC5988 relation-based navigation (first, prev, next, last).
   *
   * - Single-origin group types: the contributing API's real Link header
   *   relations are retained and returned as-is (absolute URLs), per RFC5988.
   * - Multi-origin (merged) group types: each origin keeps advancing through
   *   its OWN real Link header; the per-origin URLs are combined into a
   *   single opaque cursor value carried in `links.next` / `links.prev` so
   *   callers keep using the exact same relation-based API. Pagination is
   *   therefore represented coherently instead of silently discarded, while
   *   staying bounded and deterministic (one bounded page per origin per
   *   navigation - never a recursive/unbounded fetch of the whole registry).
   *
   * Every request - including the very first one - is bounded with an
   * explicit `limit` query parameter (`pageSize`, default 50) so a group
   * listing can never trigger an unbounded fetch.
   *
   * Identical requests (same groupType/pagePath/filter/pageSize) share a
   * single in-flight/completed result via an internal cache, so adjacent-page
   * prefetching (see `prefetchNextGroupsPage`) never causes duplicate network
   * calls.
   *
   * @param groupType the type of group to list
   * @param pageRel URL, opaque multi-origin cursor, or empty string for the first page
   * @param filter optional filter string to apply to the query
   * @param pageSize bounded page size to request (default 50)
   */
  listGroups(
    groupType: string,
    pageRel: string = '',
    filter?: string,
    pageSize: number = this.defaultGroupPageSize
  ): Observable<Page<Group[]>> {
    const pagePath = pageRel || this.buildPath(groupType);
    // The cache key MUST include the current set of contributing API
    // endpoints. Progressive model loading can discover a new origin for
    // this group type after an earlier (e.g. single-origin) page was already
    // cached; without this, a later call would replay that stale, now-
    // incomplete cached page instead of re-querying with the full, current
    // origin set.
    const contributingApis = this.modelService.getApiEndpointsForGroupType(groupType);
    const cacheKey = this.groupsPageCacheKey(groupType, pagePath, filter, pageSize, contributingApis);

    let pending = this.groupsPageCache.get(cacheKey);
    if (!pending) {
      pending = this.listGroupsAsync(groupType, pagePath, filter, pageSize).then(page => {
        // Do not keep a resolved failure/partial-failure page cached.
        // listGroupsAsync catches per-API errors internally and RESOLVES
        // (rather than rejects) with a Page describing the failure, so a
        // plain `.catch()` below is not enough to guard against this: a
        // retry, or recovery of a previously-failing/transient origin, must
        // hit the network again instead of forever replaying the same
        // cached failure.
        if ((page.failedApis ?? 0) > 0 || page.successfulApis === 0) {
          this.groupsPageCache.delete(cacheKey);
        }
        return page;
      });
      this.groupsPageCache.set(cacheKey, pending);
      // Defensive: also evict on a genuine promise rejection, in case
      // listGroupsAsync's internal error handling ever changes.
      pending.catch(() => this.groupsPageCache.delete(cacheKey));
    }
    return from(pending);
  }

  /**
   * Prefetch the single adjacent next page for a group listing, sharing the
   * same request-cache used by `listGroups` so a subsequent real navigation
   * reuses the already-fetched result instead of issuing a duplicate
   * request. This intentionally prefetches only ONE page ahead and never
   * chains further prefetch calls from within itself, so it can never
   * cascade into downloading the entire registry.
   */
  prefetchNextGroupsPage(
    groupType: string,
    page: Page<Group[]> | null | undefined,
    filter?: string,
    pageSize: number = this.defaultGroupPageSize
  ): void {
    const nextRel = page?.links?.next;
    if (!nextRel) {
      return;
    }
    // Must use the SAME API-aware cache key as listGroups() (see there for
    // why the contributing API set is part of the key), otherwise this
    // "already cached?" check could look up the wrong entry entirely.
    const contributingApis = this.modelService.getApiEndpointsForGroupType(groupType);
    const cacheKey = this.groupsPageCacheKey(groupType, nextRel, filter, pageSize, contributingApis);
    if (this.groupsPageCache.has(cacheKey)) {
      return; // Already fetched, in flight, or previously prefetched.
    }
    this.debug.log(`Prefetching adjacent next groups page for '${groupType}'`);
    // Fire-and-forget: only populates the shared cache. No recursive prefetch.
    this.listGroups(groupType, nextRel, filter, pageSize).subscribe({
      error: (err) => this.debug.warn(`Prefetch of next groups page failed for '${groupType}':`, err)
    });
  }

  private groupsPageCacheKey(
    groupType: string,
    pagePath: string,
    filter: string | undefined,
    pageSize: number,
    contributingApis: string[]
  ): string {
    // Sorted so the key is stable regardless of the (irrelevant) order
    // getApiEndpointsForGroupType happens to return endpoints in.
    const apiSetKey = [...contributingApis].sort().join(',');
    return `${groupType}::${pagePath}::${filter || ''}::${pageSize}::${apiSetKey}`;
  }

  /**
   * Async implementation of listGroups with relation-based URL
   */
  private async listGroupsAsync(
    groupType: string,
    pagePath: string,
    filter: string | undefined,
    pageSize: number
  ): Promise<Page<Group[]>> {
    const model = await lastValueFrom(this.modelService.getRegistryModel());
    const apis = this.modelService.getApiEndpointsForGroupType(groupType);
    if (apis.length === 0) {
      return { items: [], links: {}, totalApis: 0, successfulApis: 0, failedApis: 0, pageSize };
    }

    const meta = model.groups[groupType] || { singular: groupType, attributes: {} };
    const mapEntry = (key: string, entry: any, origin: string): Group => {
      const idKey = meta.singular + 'id';
      return {
        id: entry[idKey] || entry.id || key,
        name: entry.name,
        createdAt: entry.createdat,
        modifiedAt: entry.modifiedat,
        origin,
        ...entry
      } as Group;
    };

    // Page 2+ of a merged, multi-origin listing: resume each origin from its
    // own previously-captured Link relation.
    if (this.isMultiOriginCursor(pagePath)) {
      return this.listGroupsFromMultiOriginCursor(groupType, pagePath, filter, pageSize, mapEntry, apis);
    }

    // Absolute URL: continuing pagination for a SINGLE contributing origin.
    // Retain and use its real RFC5988 Link header as-is.
    if (pagePath.startsWith('http')) {
      const targetApi = apis.find(api => pagePath.startsWith(api)) || apis[0];
      try {
        const url = this.addFilterToUrl(pagePath, filter);
        const response = await lastValueFrom(
          this.http.get<{ [id: string]: any }>(url, { observe: 'response' as const })
        );
        const data = response.body || {};
        const linkHeader = response.headers.get('Link') || '';
        this.debug.log(`Link header received for groups: ${linkHeader}`);
        const links = this.parseGroupLinkHeader(linkHeader);
        const totalCount = this.parseGroupTotalCount(response);
        const { currentPage, totalPages } = this.deriveGroupPageMeta(pageSize, totalCount, links);
        const groups: Group[] = Object.entries(data).map(([key, entry]) => mapEntry(key, entry, targetApi));
        return { items: groups, links, totalApis: 1, successfulApis: 1, failedApis: 0, pageSize, totalCount, currentPage, totalPages };
      } catch (err) {
        this.debug.error(`Failed to list groups from absolute URL ${pagePath}:`, err);
        return { items: [], links: {}, totalApis: 1, successfulApis: 0, failedApis: 1, error: err, pageSize };
      }
    }

    // Initial (bounded) load: query all contributing origins in parallel,
    // applying an explicit `limit` on every request so this can never turn
    // into an unbounded fetch.
    return this.listGroupsFromAllOrigins(groupType, pagePath, filter, pageSize, mapEntry, apis);
  }

  /**
   * Query every contributing origin for the first bounded page of a group
   * type and merge the results. When a single origin contributes, its real
   * RFC5988 Link header is passed through untouched. When multiple origins
   * contribute, their individual `next` (and `prev`, once available) Link
   * relations are combined into a single opaque, bounded, deterministic
   * cursor rather than being silently dropped.
   */
  private async listGroupsFromAllOrigins(
    groupType: string,
    pagePath: string,
    filter: string | undefined,
    pageSize: number,
    mapEntry: (key: string, entry: any, origin: string) => Group,
    apis: string[]
  ): Promise<Page<Group[]>> {
    this.debug.log(`Querying ${apis.length} API(s) for group type '${groupType}': ${apis.join(', ')}`);

    const apiRequests = apis.map(async (api) => {
      try {
        const url = this.withBoundedLimit(this.getApiUrl(api, pagePath, filter), pageSize);
        this.debug.log(`Requesting groups from: ${url}`);
        const response = await lastValueFrom(this.httpGetWithRetry<{ [id: string]: any }>(url));
        const data = response.body || {};
        const links = this.parseGroupLinkHeader(response.headers.get('Link') || '');
        const totalCount = this.parseGroupTotalCount(response);
        const groups = Object.entries(data).map(([key, entry]) => mapEntry(key, entry, api));
        this.debug.log(`Successfully loaded ${groups.length} groups from ${api}`);
        return { api, groups, links, totalCount, success: true, error: null as any };
      } catch (err) {
        this.debug.error(`Failed to list groups from ${api}:`, err);
        return { api, groups: [] as Group[], links: {} as { [rel: string]: string }, totalCount: undefined as number | undefined, success: false, error: err };
      }
    });

    const results = await Promise.all(apiRequests);

    const allGroups: Group[] = [];
    const successfulApis: string[] = [];
    const failedApis: string[] = [];
    const errors: any[] = [];
    const nextByOrigin: { [api: string]: string } = {};

    results.forEach(result => {
      if (result.success) {
        successfulApis.push(result.api);
        if (result.groups.length > 0) {
          allGroups.push(...result.groups);
        }
        if (result.links['next']) {
          nextByOrigin[result.api] = result.links['next'];
        }
      } else {
        failedApis.push(result.api);
        if (result.error) {
          errors.push({ api: result.api, error: result.error });
        }
      }
    });

    this.debug.log(`Merged ${allGroups.length} total groups from ${successfulApis.length} successful API(s): ${successfulApis.join(', ')}`);
    if (failedApis.length > 0) {
      this.debug.log(`Failed APIs (${failedApis.length}): ${failedApis.join(', ')}`);
    }

    const links: { [rel: string]: string } = {};
    // Only ever populated for a single contributing origin - see
    // parseGroupTotalCount() for why a merged multi-origin listing
    // intentionally leaves these undefined instead of guessing.
    let totalCount: number | undefined;
    let currentPage: number | undefined;
    let totalPages: number | undefined;

    if (successfulApis.length === 1) {
      // Exactly one contributing origin: pass its real RFC5988 relations through untouched.
      const only = results.find(r => r.success);
      if (only?.links) {
        Object.assign(links, only.links);
      }
      totalCount = only?.totalCount;
      ({ currentPage, totalPages } = this.deriveGroupPageMeta(pageSize, totalCount, links));
    } else if (Object.keys(nextByOrigin).length > 0) {
      // Multiple contributing origins: represent paging coherently via a
      // bounded, deterministic composite cursor instead of dropping it. The
      // "previous" breadcrumb for THIS first page is the plain, bounded,
      // all-origins initial query - carried forward so page 2 can expose an
      // exact `links.prev` even after some origins become exhausted.
      const nextCursor = this.encodeMultiOriginCursor(nextByOrigin, this.buildPath(groupType));
      if (nextCursor) {
        links['next'] = nextCursor;
      }
    }

    const result: Page<Group[]> = {
      items: allGroups,
      links,
      totalApis: apis.length,
      successfulApis: successfulApis.length,
      failedApis: failedApis.length,
      pageSize,
      totalCount,
      currentPage,
      totalPages
    };

    if (successfulApis.length === 0) {
      result.error = errors.length > 0 ? errors[0].error : new Error('All API endpoints failed to respond');
      result.allApiErrors = errors;
    }

    return result;
  }

  /**
   * Resume a merged, multi-origin group listing from a previously encoded
   * composite cursor. Only the origins that still had a `next` relation are
   * fetched - already-exhausted origins are correctly skipped - so this
   * remains a single bounded page per origin and never re-downloads or
   * recursively prefetches the rest of the registry.
   *
   * `links.prev` is deliberately NOT reconstructed from the current fetch's
   * per-origin `prev` relations: once an origin has dropped out of the
   * cursor (exhausted on an earlier page), there is no way to recompose that
   * earlier merged page's content from only the origins active on THIS page.
   * Instead, `links.prev` is taken directly from the `previous` breadcrumb
   * carried inside the incoming cursor - the exact cursor (or the initial
   * `/<groupType>` path) that was used to fetch the page before this one -
   * so backward navigation deterministically replays that earlier request.
   */
  private async listGroupsFromMultiOriginCursor(
    groupType: string,
    cursor: string,
    filter: string | undefined,
    pageSize: number,
    mapEntry: (key: string, entry: any, origin: string) => Group,
    apis: string[]
  ): Promise<Page<Group[]>> {
    const decoded = this.decodeMultiOriginCursor(cursor);
    const origins = decoded.origins;
    const originApis = Object.keys(origins);
    const previous = decoded.previous || this.buildPath(groupType);

    if (originApis.length === 0) {
      return { items: [], links: { first: this.buildPath(groupType), prev: previous }, totalApis: apis.length, successfulApis: 0, failedApis: 0, pageSize };
    }

    this.debug.log(`Fetching next bounded page from ${originApis.length} origin(s) via composite cursor for '${groupType}'`);

    const apiRequests = originApis.map(async (api) => {
      try {
        // The origin's own Link URL already encodes the correct offset/limit;
        // only the filter needs to be re-applied to preserve search state.
        const url = this.addFilterToUrl(origins[api], filter);
        const response = await lastValueFrom(
          this.http.get<{ [id: string]: any }>(url, { observe: 'response' as const })
        );
        const data = response.body || {};
        const links = this.parseGroupLinkHeader(response.headers.get('Link') || '');
        const groups = Object.entries(data).map(([key, entry]) => mapEntry(key, entry, api));
        return { api, groups, links, success: true, error: null as any };
      } catch (err) {
        this.debug.error(`Failed to fetch next groups page from ${api}:`, err);
        return { api, groups: [] as Group[], links: {} as { [rel: string]: string }, success: false, error: err };
      }
    });

    const results = await Promise.all(apiRequests);

    const allGroups: Group[] = [];
    const successfulApis: string[] = [];
    const failedApis: string[] = [];
    const errors: any[] = [];
    const nextByOrigin: { [api: string]: string } = {};

    results.forEach(result => {
      if (result.success) {
        successfulApis.push(result.api);
        allGroups.push(...result.groups);
        if (result.links['next']) {
          nextByOrigin[result.api] = result.links['next'];
        }
      } else {
        failedApis.push(result.api);
        if (result.error) {
          errors.push({ api: result.api, error: result.error });
        }
      }
    });

    const links: { [rel: string]: string } = {
      // 'first' always returns to the original bounded, all-origins query.
      first: this.buildPath(groupType),
      // 'prev' replays the exact cursor/path that produced the page before
      // this one - never reconstructed from (possibly incomplete) per-origin
      // data on the current page.
      prev: previous
    };
    // This page's own incoming cursor becomes the "previous" breadcrumb for
    // the NEXT page, so backward navigation from page N+1 can replay page N
    // exactly - even if an origin exhausts between now and then.
    const nextCursor = this.encodeMultiOriginCursor(nextByOrigin, cursor);
    if (nextCursor) {
      links['next'] = nextCursor;
    }

    const result: Page<Group[]> = {
      items: allGroups,
      links,
      totalApis: apis.length,
      successfulApis: successfulApis.length,
      failedApis: failedApis.length,
      pageSize
    };

    if (successfulApis.length === 0) {
      result.error = errors.length > 0 ? errors[0].error : new Error('All origins failed to respond');
      result.allApiErrors = errors;
    }

    return result;
  }

}
