/**
 * Fork: context pills of the Android assistant panel. Each pill is one piece of context from the
 * screen or the phone. A tap attaches or leaves it out; a hold opens it to read and edit.
 */
export type ContextPillKind = "screenshot" | "screenText" | "selection" | "link" | "clipboard";
export type TextContextPillKind = Exclude<ContextPillKind, "screenshot">;

export const CONTEXT_PILL_ORDER: ReadonlyArray<ContextPillKind> = [
  "selection",
  "screenshot",
  "screenText",
  "link",
  "clipboard",
];

const SELECTION_LABEL_LENGTH = 24;

export function isTextContextPill(kind: ContextPillKind): kind is TextContextPillKind {
  return kind !== "screenshot";
}

function nonEmptyLines(text: string): number {
  return text.split("\n").filter((line) => line.trim().length > 0).length;
}

function linkHost(link: string): string {
  try {
    return new URL(link).host || link;
  } catch {
    return link;
  }
}

export function contextPillLabel(kind: ContextPillKind, value: string): string {
  switch (kind) {
    case "screenshot":
      return "Screenshot";
    case "screenText":
      return `Screen text · ${nonEmptyLines(value)} lines`;
    case "selection": {
      const flat = value.split("\n").join(" ").trim();
      return flat.length > SELECTION_LABEL_LENGTH
        ? `“${flat.slice(0, SELECTION_LABEL_LENGTH).trimEnd()}…”`
        : `“${flat}”`;
    }
    case "link":
      return linkHost(value);
    case "clipboard":
      return "Clipboard";
  }
}

function quote(text: string): string {
  return text
    .trim()
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

/** The context that goes into the message body: short, so a file attachment would only hide it. */
export function inlineContextText(input: {
  readonly selection: string | null;
  readonly link: string | null;
  readonly clipboard: string | null;
}): string {
  return [
    input.link ? `Link: ${input.link}` : null,
    input.selection?.trim() ? `Selected text:\n${quote(input.selection)}` : null,
    input.clipboard?.trim() ? `Clipboard:\n${quote(input.clipboard)}` : null,
  ]
    .filter((block) => block !== null)
    .join("\n\n");
}

/** The screen text file, headed by the app it came from. */
export function screenTextDocument(sourcePackage: string | null, text: string): string {
  return sourcePackage ? `App: ${sourcePackage}\n\n${text}` : text;
}

export function joinMessageText(userText: string, contextText: string): string {
  return [userText.trim(), contextText].filter((part) => part.length > 0).join("\n\n");
}
