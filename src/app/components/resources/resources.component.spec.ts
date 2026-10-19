import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute } from '@angular/router';
import { HttpClientTestingModule } from '@angular/common/http/testing';
import { of } from 'rxjs';

import { ResourcesComponent } from './resources.component';
import { RegistryService } from '../../services/registry.service';
import { ConfigService } from '../../services/config.service';
import { ModelService } from '../../services/model.service';
import { IconComponent } from '../icon/icon.component';
import { PLATFORM_ID, CUSTOM_ELEMENTS_SCHEMA } from '@angular/core';
import { By } from '@angular/platform-browser';
import { ResourceRowComponent } from '../resource-row/resource-row.component';

describe('ResourcesComponent', () => {
  let component: ResourcesComponent;
  let fixture: ComponentFixture<ResourcesComponent>;
  beforeEach(async () => {
    const activatedRouteMock = {
      params: of({ groupType: 'endpoints', groupId: 'test-group' }),
      queryParams: of({}),
      snapshot: {
        params: { groupType: 'endpoints', groupId: 'test-group' },
        queryParams: {},
        paramMap: {
          get: jest.fn((key: string) => {
            const params: { [key: string]: string } = { groupType: 'endpoints', groupId: 'test-group' };
            return params[key] || '';
          })
        },
        queryParamMap: {
          get: jest.fn(() => '')
        }
      }
    };    await TestBed.configureTestingModule({
      imports: [
        ResourcesComponent,
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

    fixture = TestBed.createComponent(ResourcesComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('passes route context to list rows with slash-containing resource IDs', () => {
    component.loading = false;
    component.hasError = false;
    component.viewMode = 'list';
    component.groupType = 'endpoints';
    component.groupId = 'test-group';
    component.resourceType = 'modules';
    component.filteredResourcesList = [{ id: 'github.com/example/module', name: 'github.com/example/module' }];

    fixture.detectChanges();

    const row = fixture.debugElement.query(By.directive(ResourceRowComponent))
      .componentInstance as ResourceRowComponent;
    expect(row.groupType).toBe('endpoints');
    expect(row.groupId).toBe('test-group');
    expect(row.resourceRoute().toString()).toBe('/endpoints/test-group/modules/github.com%2Fexample%2Fmodule');
  });
});
