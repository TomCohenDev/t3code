import { shortcutLabelForCommand } from "./keybindings";
import { describe, expect, it } from "vite-plus/test";
import { settleProjectScript, setupProjectScript } from "@t3tools/shared/projectScripts";

import {
  buildProjectScript,
  commandForProjectScript,
  nextProjectScriptId,
  primaryProjectScript,
  releaseClaimedRoles,
  shouldShowScriptTerminal,
} from "./projectScripts";

describe("projectScripts helpers", () => {
  const backgroundInput = {
    name: "Navgator",
    command: "bash navgator.sh",
    icon: "play",
    runOnWorktreeCreate: false,
    waitForSetup: false,
    runOnSettle: false,
    previewUrl: null,
    autoOpenPreview: false,
    previewOverlay: false,
  } as const;

  it("stores runInBackground only when it is on", () => {
    const on = buildProjectScript("nav", { ...backgroundInput, runInBackground: true });
    expect(on.runInBackground).toBe(true);
    const off = buildProjectScript("nav", { ...backgroundInput, runInBackground: false });
    expect("runInBackground" in off).toBe(false);
  });

  it("shows the terminal drawer unless the script runs in background", () => {
    const script = buildProjectScript("nav", { ...backgroundInput, runInBackground: false });
    expect(shouldShowScriptTerminal(script)).toBe(true);
    expect(shouldShowScriptTerminal({ ...script, runInBackground: false })).toBe(true);
    expect(shouldShowScriptTerminal({ ...script, runInBackground: true })).toBe(false);
  });

  it("stores previewOverlay only with a preview URL and only when it is on", () => {
    const input = {
      name: "Navgator",
      command: "navgator web --no-open",
      icon: "play",
      runOnWorktreeCreate: false,
      waitForSetup: false,
      runOnSettle: false,
      autoOpenPreview: true,
      runInBackground: true,
    } as const;
    const overlay = buildProjectScript("nav", {
      ...input,
      previewUrl: "http://127.0.0.1:4748",
      previewOverlay: true,
    });
    expect(overlay.previewOverlay).toBe(true);
    const noUrl = buildProjectScript("nav", { ...input, previewUrl: null, previewOverlay: true });
    expect("previewOverlay" in noUrl).toBe(false);
  });

  it.each(["install-javascript-dependencies", "A", "a.b", "a b", "-a", "", "a".repeat(25)])(
    "omits the shortcut for legacy script ID %j without crashing script menus",
    (id) => {
      const commands = ["lint", id, "test"].map(commandForProjectScript);
      expect(commands).toEqual(["script.lint.run", null, "script.test.run"]);
      expect(commands.map((command) => shortcutLabelForCommand([], command))).toEqual([
        null,
        null,
        null,
      ]);
    },
  );

  it("slugifies and dedupes project script ids", () => {
    expect(nextProjectScriptId("Run Tests", [])).toBe("run-tests");
    expect(nextProjectScriptId("Run Tests", ["run-tests"])).toBe("run-tests-2");
    expect(nextProjectScriptId("!!!", [])).toBe("script");
  });

  it("resolves primary, setup, and settle scripts", () => {
    const scripts = [
      {
        id: "setup",
        name: "Setup",
        command: "bun install",
        icon: "configure" as const,
        runOnWorktreeCreate: true,
      },
      {
        id: "clean",
        name: "Clean",
        command: "cargo clean",
        icon: "build" as const,
        runOnWorktreeCreate: false,
        runOnSettle: true,
      },
      {
        id: "test",
        name: "Test",
        command: "bun test",
        icon: "test" as const,
        runOnWorktreeCreate: false,
      },
    ];

    expect(primaryProjectScript(scripts)?.id).toBe("test");
    expect(setupProjectScript(scripts)?.id).toBe("setup");
    expect(settleProjectScript(scripts)?.id).toBe("clean");
    expect(primaryProjectScript(scripts.filter((script) => script.id === "clean"))).toBeNull();
  });

  it("moves the setup and settle roles to the script that claims them", () => {
    const input = {
      name: "Next",
      command: "true",
      icon: "play",
      waitForSetup: false,
      previewUrl: null,
      autoOpenPreview: false,
      previewOverlay: false,
      runInBackground: false,
    } as const;
    const holder = {
      id: "holder",
      name: "Holder",
      command: "true",
      icon: "play" as const,
      runOnWorktreeCreate: true,
      runOnSettle: true,
    };

    expect(
      releaseClaimedRoles(holder, { ...input, runOnWorktreeCreate: false, runOnSettle: true }),
    ).toMatchObject({ runOnWorktreeCreate: true, runOnSettle: false });
    expect(
      releaseClaimedRoles(holder, { ...input, runOnWorktreeCreate: true, runOnSettle: false }),
    ).toMatchObject({ runOnWorktreeCreate: false, runOnSettle: true });
    expect(
      releaseClaimedRoles(holder, { ...input, runOnWorktreeCreate: false, runOnSettle: false }),
    ).toBe(holder);
  });
});
