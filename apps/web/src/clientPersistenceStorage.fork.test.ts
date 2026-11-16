import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { readBrowserClientSettings } from "./clientPersistenceStorage";

function createLocalStorageStub(): Storage {
  const store = new Map<string, string>();
  return {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => {
      store.set(key, value);
    },
    removeItem: (key) => {
      store.delete(key);
    },
    clear: () => {
      store.clear();
    },
    key: (index) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    },
  };
}

function getTestWindow(): Window & typeof globalThis {
  const localStorage = createLocalStorageStub();
  const testWindow = {
    localStorage,
  } as Window & typeof globalThis;
  vi.stubGlobal("window", testWindow);
  vi.stubGlobal("localStorage", localStorage);
  return testWindow;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("clientPersistenceStorage", () => {
  it("moves the old sidebar group settings to the tab keys once", () => {
    const testWindow = getTestWindow();
    testWindow.localStorage.setItem(
      "t3code:client-settings:v1",
      JSON.stringify({ sidebarGroupsEnabled: true, sidebarGroupSingleThreadOpens: true }),
    );
    const settings = readBrowserClientSettings();
    expect(settings?.sidebarTabsEnabled).toBe(true);
    expect(settings?.sidebarTabSingleThreadOpens).toBe(true);
    expect(JSON.parse(testWindow.localStorage.getItem("t3code:client-settings:v1")!)).toEqual({
      sidebarTabsEnabled: true,
      sidebarTabSingleThreadOpens: true,
    });
  });
});
