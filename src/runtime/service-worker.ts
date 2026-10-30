/**
 * Chrome MV3 Service Worker.
 * Ownership: Action button routing only.
 * Invariant: Toolbar action opens or reuses the extension page (export.html).
 * Never holds long-lived data jobs, tokens, or network extractions.
 */

export interface TabsPort {
  query(queryInfo: chrome.tabs.QueryInfo): Promise<chrome.tabs.Tab[]>;
  update(tabId: number, updateProperties: chrome.tabs.UpdateProperties): Promise<chrome.tabs.Tab | undefined>;
  create(createProperties: chrome.tabs.CreateProperties): Promise<chrome.tabs.Tab>;
}

export interface RuntimePort {
  getURL(path: string): string;
}

export async function openOrReuseExportPage(
  tabs: TabsPort,
  runtime: RuntimePort
): Promise<chrome.tabs.Tab> {
  const exportUrl = runtime.getURL('export.html');
  const existingTabs = await tabs.query({ url: exportUrl });

  if (existingTabs.length > 0 && typeof existingTabs[0].id === 'number') {
    const updated = await tabs.update(existingTabs[0].id, { active: true });
    if (updated) return updated;
  }

  return tabs.create({ url: exportUrl, active: true });
}

// Attach listener in browser extension runtime
if (typeof chrome !== 'undefined' && chrome.action?.onClicked) {
  chrome.action.onClicked.addListener(() => {
    void openOrReuseExportPage(chrome.tabs, chrome.runtime);
  });
}
