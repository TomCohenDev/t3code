import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import { SidebarProvider } from "../ui/sidebar";

const settingsOverrides = vi.hoisted(() => ({ brandingHidden: false }));
vi.mock(import("../../hooks/useSettings"), async (original) => {
  const actual = await original();
  type Settings = ReturnType<typeof actual.getClientSettings>;
  function useClientSettings<T = Settings>(select?: (settings: Settings) => T): T {
    const settings = { ...actual.getClientSettings(), ...settingsOverrides };
    return select ? select(settings) : (settings as T);
  }
  return { ...actual, useClientSettings, useEnvironmentIdentificationMode: () => "pill" as const };
});
vi.mock(import("../SidebarStageBackdrop"), async (original) => ({
  ...(await original()),
  useEnvironmentStageLabel: () => "Dev",
}));

import { SidebarChromeHeader } from "./SidebarChrome";

function setup(brandingHidden: boolean) {
  settingsOverrides.brandingHidden = brandingHidden;
}

const header = (
  <SidebarProvider>
    <SidebarChromeHeader isElectron={false} />
  </SidebarProvider>
);

describe("SidebarChromeHeader branding", () => {
  it("shows the wordmark link and the pill while brandingHidden is off", async () => {
    setup(false);
    await using screen = await render(header);
    await expect.element(screen.getByText("Dev")).toBeInTheDocument();
    expect(screen.container.querySelector('a[data-fork-brand="wordmark"]')).not.toBeNull();
    expect(screen.container.querySelector('[data-fork-brand="pill"]')).not.toBeNull();
  });

  it("hides the wordmark link and the pill while brandingHidden is on", async () => {
    setup(true);
    await using screen = await render(header);
    await expect
      .element(screen.getByRole("button", { name: "Toggle main sidebar" }))
      .toBeInTheDocument();
    expect(screen.container.querySelector('[data-fork-brand="wordmark"]')).toBeNull();
    expect(screen.container.querySelector('[data-fork-brand="pill"]')).toBeNull();
  });
});
