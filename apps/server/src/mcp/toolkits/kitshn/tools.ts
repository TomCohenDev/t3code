/** Fork: kitshn publishing through the machine's kitshn daemon (`fork/kitshn/KitshnPublish.ts`). */
import { OrchestratorMcpFailure } from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/ai";

import * as KitshnPublish from "../../../fork/kitshn/KitshnPublish.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    KitshnPublish.KitshnPublish,
  ],
};

const KitshnPublishTool = Tool.make("kitshn_publish", {
  ...shared,
  description:
    'Publish a file or folder of this thread\'s workspace to kitshn: a .html file becomes a page, another file a file card, a folder a static site without dotfiles and links. Path "." is the whole workspace; prefer a build folder. The same name updates its card; circle, public, address and zone apply only to its first publish. Without circle the card stays private. Runs as this thread through the kitshn daemon of this machine. Full-access threads only. If kitshn needs an approval, by default of the owner, the call waits 60 seconds, then returns outcome "waiting" and nothing ran: tell the user, and after the approval send the same call with the same arguments again within 1 hour. The result is {address, card, kind (page, file or folder), updated, revision?} or {outcome "waiting", proposalId, message}.',
  parameters: KitshnPublish.KitshnPublishInput,
  success: KitshnPublish.KitshnPublishAnswer,
}).annotate(Tool.Destructive, true);

const KitshnAddressTool = Tool.make("kitshn_address", {
  ...shared,
  description:
    'Give a kitshn page, file or folder site a new address name. The old address redirects. Runs like kitshn_publish, also its outcome "waiting". Full-access threads only. The result is {address, card, kind, revision?} or {outcome "waiting", proposalId, message}.',
  parameters: KitshnPublish.KitshnAddressInput,
  success: KitshnPublish.KitshnAddressAnswer,
}).annotate(Tool.Destructive, true);

export const KitshnToolkit = Toolkit.make(KitshnPublishTool, KitshnAddressTool);
