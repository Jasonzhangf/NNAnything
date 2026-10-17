declare namespace chrome {
  export namespace action {
    export function setBadgeText(details: { tabId?: number; text: string }): Promise<void>;
    export function setBadgeBackgroundColor(details: { tabId?: number; color: string }): Promise<void>;
    export function setTitle(details: { tabId?: number; title: string }): Promise<void>;
    export const onClicked: {
      addListener(callback: (tab: chrome.tabs.Tab) => void | Promise<void>): void;
    };
  }

  export namespace tabs {
    export interface Tab {
      id?: number;
      url?: string;
      title?: string;
      [key: string]: unknown;
    }
  }

  export namespace scripting {
    export function executeScript(injection: {
      target: { tabId: number; allFrames?: boolean };
      files?: string[];
      func?: (...args: any[]) => any;
      args?: any[];
    }): Promise<any[]>;
  }
}
