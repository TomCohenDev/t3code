import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  buildT3ProjectFileJsonSchema,
  parseT3ProjectFile,
  T3ProjectFileFromJson,
} from "./t3ProjectFile.ts";

const decodeJson = Schema.decodeUnknownSync(T3ProjectFileFromJson);

describe("T3ProjectFileFromJson", () => {
  it("decodes lenient JSONC with comments and trailing commas", () => {
    const decoded = decodeJson(`{
      // team scripts
      "iconPath": "assets/logo.svg",
      "scripts": [
        { "name": "Dev", "command": "pnpm dev", },
      ],
    }`);

    expect(decoded.iconPath).toBe("assets/logo.svg");
    expect(decoded.scripts?.[0]).toEqual({ name: "Dev", command: "pnpm dev" });
  });
});

describe("parseT3ProjectFile", () => {
  it("reads project defaults from JSONC with a URL in a block comment", () => {
    expect(
      parseT3ProjectFile(`{
        /* See https://t3.codes/schema/t3.json */
        "defaultThreadEnvMode": "worktree"
      }`),
    ).toEqual({ defaultThreadEnvMode: "worktree" });
  });
});

describe("fork t3.json schema", () => {
  // Fork: a project script can run in the background (Global scripts).
  it("documents runInBackground on scripts", () => {
    const schema = buildT3ProjectFileJsonSchema() as {
      properties: { scripts?: { items?: { properties: Record<string, unknown> } } };
    };
    expect(schema.properties.scripts?.items?.properties).toHaveProperty("runInBackground");
  });
});
