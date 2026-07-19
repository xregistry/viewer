import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute } from '@angular/router';
import { HttpClientTestingModule } from '@angular/common/http/testing';
import { of } from 'rxjs';

import { GroupsComponent } from './groups.component';
import { RegistryService } from '../../services/registry.service';
import { ConfigService } from '../../services/config.service';
import { ModelService } from '../../services/model.service';
import { IconComponent } from '../icon/icon.component';
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
