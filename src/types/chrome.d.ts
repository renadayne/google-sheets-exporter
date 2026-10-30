// Minimal Chrome API definitions required for T07 MV3 service worker and extension page
declare namespace chrome {
  namespace action {
    interface Tab {
      id?: number;
      url?: string;
      windowId?: number;
    }
    interface ClickEvent {
      addListener(callback: (tab: Tab) => void): void;
    }
    const onClicked: ClickEvent;
  }

  namespace tabs {
    interface QueryInfo {
      url?: string | string[];
      active?: boolean;
      currentWindow?: boolean;
    }
    interface Tab {
      id?: number | undefined;
      url?: string | undefined;
      active?: boolean | undefined;
      windowId?: number | undefined;
    }
    interface UpdateProperties {
      active?: boolean | undefined;
    }
    interface CreateProperties {
      url: string;
      active?: boolean | undefined;
    }

    function query(queryInfo: QueryInfo): Promise<Tab[]>;
    function update(tabId: number, updateProperties: UpdateProperties): Promise<Tab | undefined>;
    function create(createProperties: CreateProperties): Promise<Tab>;
  }

  namespace runtime {
    function getURL(path: string): string;
    const id: string;
  }
}
