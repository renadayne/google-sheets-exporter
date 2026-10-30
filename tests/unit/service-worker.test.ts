import { describe, it, expect } from 'vitest';
import { openOrReuseExportPage, type TabsPort, type RuntimePort } from '../../src/runtime/service-worker.ts';

describe('Service worker action routing', () => {
  const fakeRuntime: RuntimePort = {
    getURL: (path: string) => `chrome-extension://test-ext-id/${path}`
  };

  it('reuses existing tab if export.html is already open', async () => {
    let updatedTabId: number | null = null;
    let createCalled = false;

    const fakeTabs: TabsPort = {
      query: async (queryInfo) => {
        expect(queryInfo.url).toBe('chrome-extension://test-ext-id/export.html');
        return [{ id: 42, url: 'chrome-extension://test-ext-id/export.html', active: false }];
      },
      update: async (tabId, props) => {
        updatedTabId = tabId;
        return { id: tabId, active: props.active };
      },
      create: async () => {
        createCalled = true;
        return { id: 99 };
      }
    };

    const tab = await openOrReuseExportPage(fakeTabs, fakeRuntime);
    expect(tab.id).toBe(42);
    expect(updatedTabId).toBe(42);
    expect(createCalled).toBe(false);
  });

  it('creates new tab if export.html is not open', async () => {
    let createdUrl: string | null = null;

    const fakeTabs: TabsPort = {
      query: async () => [],
      update: async () => undefined,
      create: async (props) => {
        createdUrl = props.url;
        return { id: 101, url: props.url, active: props.active };
      }
    };

    const tab = await openOrReuseExportPage(fakeTabs, fakeRuntime);
    expect(tab.id).toBe(101);
    expect(createdUrl).toBe('chrome-extension://test-ext-id/export.html');
  });
});
