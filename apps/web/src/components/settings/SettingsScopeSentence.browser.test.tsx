import type { MachineMapCircleSettings } from "@t3tools/contracts";
import { page, userEvent } from "vite-plus/test/browser";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import type { SettingsScopeSearch } from "./settingsScope";

const mocks = vi.hoisted(() => ({
  circles: [] as MachineMapCircleSettings[],
  search: {} as SettingsScopeSearch,
  selectScope: vi.fn<(next: SettingsScopeSearch) => void>(),
  reset: vi.fn<() => void>(),
}));

vi.mock(import("../../machineMap/circleSettings"), async (original) => ({
  ...(await original()),
  useSettingsPersonPicker: (() => ({ environmentId: "mac", circles: mocks.circles })) as never,
  useResetSelectedCircle: (() =>
    mocks.circles.some((circle) => circle.id === mocks.search.circle && circle.settings !== null)
      ? mocks.reset
      : null) as never,
}));
vi.mock(import("./SettingsScopeContext"), async (original) => ({
  ...(await original()),
  useOptionalSettingsScope: (() => ({
    search: mocks.search,
    selectScope: mocks.selectScope,
    singleEnvironment: false,
    groups: [],
    scope: { kind: "all", label: "All environments", members: [], environmentIds: [] },
  })) as never,
}));
vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  useEnvironments: (() => ({ environments: [] })) as never,
}));

import { SettingsScopeSentence } from "./SettingsScopeSentence";

const PARTNER: MachineMapCircleSettings = {
  id: "partner",
  name: "Partner",
  color: "#FF5277",
  settings: { server: { sidebarTabs: {} }, client: {} },
};

function setup(input: { circles: MachineMapCircleSettings[]; search: SettingsScopeSearch }) {
  mocks.circles = input.circles;
  mocks.search = input.search;
  mocks.selectScope.mockClear();
  mocks.reset.mockClear();
}

it("shows the person picker to the owner on a page with person settings", async () => {
  setup({ circles: [PARTNER], search: {} });
  await using _screen = await render(<SettingsScopeSentence />, { router: "/settings/general" });
  await expect.element(page.getByText("Applying settings for")).toBeVisible();
  await userEvent.click(page.getByRole("button", { name: "Person scope: All people" }));
  await userEvent.click(page.getByRole("menuitemradio", { name: /Partner/ }));
  expect(mocks.selectScope).toHaveBeenCalledWith({ circle: "partner" });
  await expect.element(page.getByRole("button", { name: /^Reset/ })).not.toBeInTheDocument();
});

it("names the picked circle and resets its part", async () => {
  setup({ circles: [PARTNER], search: { circle: "partner" } });
  await using _screen = await render(<SettingsScopeSentence />, { router: "/settings/general" });
  await userEvent.click(page.getByRole("button", { name: "Reset Partner" }));
  expect(mocks.reset).toHaveBeenCalledOnce();
  await userEvent.click(page.getByRole("button", { name: "Person scope: Partner" }));
  await userEvent.click(page.getByRole("menuitemradio", { name: "All people" }));
  expect(mocks.selectScope).toHaveBeenCalledWith({});
});

it("shows no sentence on a device page without circles to pick", async () => {
  setup({ circles: [], search: {} });
  await using _screen = await render(<SettingsScopeSentence />, { router: "/settings/general" });
  await expect.element(page.getByText("Applying settings for")).not.toBeInTheDocument();
});
