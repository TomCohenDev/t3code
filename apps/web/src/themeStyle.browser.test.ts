import type { EnvironmentTheme } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

const publishedThemes = vi.hoisted(() => ({
  atom: null as unknown as import("effect/reactivity").Atom.Writable<
    ReadonlyArray<EnvironmentTheme>
  >,
}));
vi.mock(import("./state/server"), async () => {
  const { Atom } = await import("effect/reactivity");
  publishedThemes.atom = Atom.make<ReadonlyArray<EnvironmentTheme>>([]);
  return { themeServerEnvironmentThemesAtom: publishedThemes.atom } as never;
});

import { fontSettingOrThemeFont } from "./appearanceFonts";
import { getActiveThemeFonts } from "./forkThemeStyle";
import { appAtomRegistry } from "./rpc/atomRegistry";
import { applyThemePalette, publishedThemeDefinitions } from "./themePalette";

const PLAIN_THEME = {
  id: "plain",
  name: "Plain",
  appearance: "light",
  canvas: "#ffffff",
  accent: "#6c5ce7",
} as const;

const STYLED_THEME = {
  ...PLAIN_THEME,
  id: "styled",
  name: "Styled",
  radius: "0",
  borderWidth: "3px",
  shadow: "4px 4px 0 0 #000",
  fonts: { sans: "Bricolage Grotesque" },
  canvasPattern: "dots",
} as const;

function withEnvironmentThemes(themes: ReadonlyArray<EnvironmentTheme>): Disposable {
  appAtomRegistry.set(publishedThemes.atom, themes);
  return {
    [Symbol.dispose]() {
      appAtomRegistry.set(publishedThemes.atom, []);
      applyThemePalette("system");
    },
  };
}

describe("theme style fields", () => {
  it("leaves the root untouched for a theme without style fields", () => {
    using _themes = withEnvironmentThemes([PLAIN_THEME]);
    applyThemePalette("plain");

    const root = document.documentElement;
    expect(publishedThemeDefinitions([PLAIN_THEME])[0]?.style).toBeUndefined();
    expect(root.style.getPropertyValue("--radius")).toBe("");
    expect(root.style.getPropertyValue("--theme-border-width")).toBe("");
    expect(root.style.getPropertyValue("--theme-shadow")).toBe("");
    expect(root.dataset.themeRadius).toBeUndefined();
    expect(root.dataset.canvasPattern).toBeUndefined();
    expect(getActiveThemeFonts()).toEqual({});
  });

  it("applies the fields of the active theme only", () => {
    using _themes = withEnvironmentThemes([PLAIN_THEME, STYLED_THEME]);
    applyThemePalette("styled");

    const root = document.documentElement;
    expect(root.style.getPropertyValue("--radius")).toBe("0");
    expect(root.style.getPropertyValue("--theme-border-width")).toBe("3px");
    expect(root.dataset.themeShadow).toBe("");
    expect(root.dataset.canvasPattern).toBe("dots");
    expect(getActiveThemeFonts()).toEqual({ sans: "Bricolage Grotesque" });

    applyThemePalette("plain");
    expect(root.style.getPropertyValue("--radius")).toBe("");
    expect(root.dataset.themeShadow).toBeUndefined();
    expect(root.dataset.canvasPattern).toBeUndefined();
    expect(getActiveThemeFonts()).toEqual({});
  });
});

describe("font precedence", () => {
  it("prefers an explicit setting and falls back to the theme font when empty", () => {
    expect(fontSettingOrThemeFont("Inter", "Bricolage Grotesque")).toBe("Inter");
    expect(fontSettingOrThemeFont("  ", "Bricolage Grotesque")).toBe("Bricolage Grotesque");
    expect(fontSettingOrThemeFont("", undefined)).toBe("");
  });
});
