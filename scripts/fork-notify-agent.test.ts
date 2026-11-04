import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

// Fork: scripts/fork-notify-agent.sh posts a failed run to the repair agent webhook. The job
// must fail when nothing confirms the delivery, else the next failure stays quiet for 90 minutes.
const script = NodePath.join(import.meta.dirname, "fork-notify-agent.sh");

const serve = (status: number, body: string, headers: Record<string, string> = {}) =>
  new Promise<{ url: string; close: () => void }>((resolve) => {
    const server = NodeHttp.createServer((_request, response) => {
      response.writeHead(status, headers);
      response.end(body);
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("no port");
      resolve({ url: `http://127.0.0.1:${address.port}/api/hooks/x`, close: () => server.close() });
    });
  });

// A fake gh on PATH: the script asks it for the previous run, and "no previous run" is enough.
const fakeGhDir = () => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-notify-"));
  const gh = NodePath.join(dir, "gh");
  NodeFS.writeFileSync(gh, "#!/bin/sh\nexit 0\n");
  NodeFS.chmodSync(gh, 0o755);
  return dir;
};

const run = (url: string) =>
  NodeChildProcess.spawnSync("bash", [script], {
    encoding: "utf8",
    env: {
      PATH: `${fakeGhDir()}:${process.env.PATH ?? ""}`,
      WEBHOOK_URL: url,
      CF_ACCESS_CLIENT_ID: "id",
      CF_ACCESS_CLIENT_SECRET: "secret",
      GH_TOKEN: "x",
      NEEDS_JSON: '{"sync":{"result":"failure"}}',
      GITHUB_REPOSITORY: "o/r",
      GITHUB_REF_NAME: "main",
      GITHUB_EVENT_NAME: "workflow_dispatch",
      GITHUB_WORKFLOW: "Fork Sync",
      GITHUB_SERVER_URL: "https://github.com",
      GITHUB_RUN_ID: "1",
    },
  });

describe("fork-notify-agent.sh", () => {
  it("fails on a redirect, which is Cloudflare Access refusing the service token", async () => {
    const server = await serve(302, "<html>302 Found</html>", {
      location: "https://example.cloudflareaccess.com/cdn-cgi/access/login/x",
    });
    try {
      const result = run(server.url);
      expect(result.status).not.toBe(0);
      expect(result.stdout + result.stderr).toContain("302");
      expect(result.stdout + result.stderr).toContain("example.cloudflareaccess.com");
    } finally {
      server.close();
    }
  });

  it("fails when the task is disabled", async () => {
    const server = await serve(409, '{"error":"hook_disabled"}', {
      "content-type": "application/json",
    });
    try {
      const result = run(server.url);
      expect(result.status).not.toBe(0);
      expect(result.stdout + result.stderr).toContain("hook_disabled");
    } finally {
      server.close();
    }
  });

  it("succeeds only on an accepted delivery", async () => {
    const server = await serve(202, '{"deliveryId":"d1"}', {
      "content-type": "application/json",
    });
    try {
      const result = run(server.url);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("d1");
    } finally {
      server.close();
    }
  });
});
