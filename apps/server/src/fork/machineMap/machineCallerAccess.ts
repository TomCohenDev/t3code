import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { assertFullAccess, assertLiveCaller, readCaller } from "../../mcp/threadAccess.ts";
import { isMachineRequestNamespace, MACHINE_MCP_CAPABILITIES } from "./machineAccess.ts";

/**
 * The peer authenticates the machine, not its thread. Until it can enforce narrower caller
 * limits, refuse forwarding rather than lend that thread the machine's broader credential.
 */
export const requireMachineToolCaller = Effect.fn("MachinePeers.requireMachineToolCaller")(
  function* () {
    const caller = yield* readCaller();
    yield* assertLiveCaller(caller);
    yield* assertFullAccess(
      caller,
      "Cross-machine tools need a live full-access/default caller. Restricted callers cannot borrow a machine's access.",
    );
    if (
      isMachineRequestNamespace(caller.scope.requestNamespace) ||
      MACHINE_MCP_CAPABILITIES.some((capability) => !caller.scope.capabilities.has(capability))
    ) {
      return yield* new OrchestratorMcpFailure({
        code: "capability_denied",
        message:
          "Cross-machine tools cannot grant missing tool capabilities or use another machine's arrows.",
      });
    }
  },
);

/**
 * MM-1902: a thread in any mode may read threads on another machine. `MachinePeers.readThread`
 * reads with a session that the peer caps at read-only, so the peer refuses every write.
 */
export const requireMachineThreadReader = Effect.fn("MachinePeers.requireMachineThreadReader")(
  function* () {
    const caller = yield* readCaller();
    yield* assertLiveCaller(caller);
    if (isMachineRequestNamespace(caller.scope.requestNamespace)) {
      return yield* new OrchestratorMcpFailure({
        code: "capability_denied",
        message: "Cross-machine reads cannot use another machine's arrows.",
      });
    }
  },
);
