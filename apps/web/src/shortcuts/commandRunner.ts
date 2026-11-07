import type { KeybindingCommand } from "@t3tools/contracts";

/**
 * Fork: runs a keybinding command from a click, such as a row in a tooltip that names the
 * command's key, as if its key had been pressed. Listeners that handle keydown (the dispatcher
 * scopes, chat shortcuts, focus levels) register a runner; the newest runner answers first. This
 * module imports nothing from the app, so leaf components can import it without a cycle.
 */
export type CommandRunner = (command: KeybindingCommand) => boolean;

const commandRunners: CommandRunner[] = [];

export function registerCommandRunner(runner: CommandRunner): () => void {
  commandRunners.push(runner);
  return () => {
    const index = commandRunners.lastIndexOf(runner);
    if (index !== -1) commandRunners.splice(index, 1);
  };
}

/** True when a handler took the command. */
export function runKeybindingCommand(command: KeybindingCommand): boolean {
  for (let index = commandRunners.length - 1; index >= 0; index -= 1) {
    if (commandRunners[index]?.(command)) return true;
  }
  return false;
}
