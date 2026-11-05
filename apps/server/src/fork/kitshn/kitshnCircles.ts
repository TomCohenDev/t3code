/** Fork: the circle layer of `t3.settings` (kitshn K-726). */
import type { DesiredParts } from "@kitshn/local";
import {
  circleSettingsOnly,
  ScopedSettingValues,
  type SettingsCircle,
  type SettingValues,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/** The circle parts that kitshn sent this machine, and the circles that hold its cards. */
export interface CircleSettings {
  /** By circle id; only the circle-capable keys of each part. */
  readonly parts: CircleParts;
  /** The circles that hold a card of this provider on this machine, smallest first. */
  readonly list: ReadonlyArray<SettingsCircle>;
}
export type CircleParts = Readonly<Record<string, ScopedSettingValues>>;

export const NO_CIRCLE_PARTS: CircleParts = {};

const decodePart = Schema.decodeUnknownOption(ScopedSettingValues);

/** The circle parts of a `t3.settings` desired state. A part that does not decode is left out. */
export const circlePartsOf = (circles: DesiredParts["circles"]): CircleParts => {
  const parts: Record<string, ScopedSettingValues> = {};
  for (const [id, value] of Object.entries(circles ?? {})) {
    const part = Option.getOrUndefined(decodePart(value));
    if (part !== undefined) parts[id] = circleSettingsOnly(part);
  }
  return parts;
};

const StateAnswer = Schema.Struct({
  circles: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      r: Schema.optionalKey(Schema.Number),
      color: Schema.optionalKey(Schema.String),
    }),
  ),
  cards: Schema.Array(
    Schema.Struct({
      kind: Schema.String,
      circles: Schema.Array(Schema.Struct({ id: Schema.String })),
    }),
  ),
});
const decodeStateAnswer = Schema.decodeUnknownOption(StateAnswer);

/**
 * The circles of the picker, from the answer of the kitshn `state` ask: the circles that hold a
 * card of this provider (`t3.` kinds) on this machine, the smallest radius first, ties by id
 * (K-726). Null when the answer has another shape.
 */
export const circleListFromState = (answer: unknown): ReadonlyArray<SettingsCircle> | null => {
  const state = Option.getOrUndefined(decodeStateAnswer(answer));
  if (state === undefined) return null;
  const holding = new Set(
    state.cards.flatMap((card) =>
      card.kind.startsWith("t3.") ? card.circles.map((circle) => circle.id) : [],
    ),
  );
  return state.circles
    .filter((circle) => holding.has(circle.id))
    .toSorted(
      (left, right) =>
        (left.r ?? Number.POSITIVE_INFINITY) - (right.r ?? Number.POSITIVE_INFINITY) ||
        // Ties by a code-unit compare of the id, as kitshn's `check` orders them.
        (left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
    )
    .map((circle) => ({ id: circle.id, name: circle.name, color: circle.color ?? null }));
};

/** The circle of `id`: from the list, or with the id as name when the list does not name it. */
export const circleOf = (settings: CircleSettings, id: string): SettingsCircle =>
  settings.list.find((circle) => circle.id === id) ?? { id, name: id, color: null };

/**
 * The circle layer of a session: the first of its circles, smallest first, that has a part.
 * K-726 lists every circle that holds the visitor and a card here, so a circle without a part,
 * or an unknown one, is skipped.
 */
export const sessionCircleLayer = (
  settings: CircleSettings,
  circles: ReadonlyArray<string>,
): { readonly circle: SettingsCircle; readonly settings: ScopedSettingValues } | null => {
  const id = circles.find((candidate) => Object.hasOwn(settings.parts, candidate));
  return id === undefined
    ? null
    : { circle: circleOf(settings, id), settings: settings.parts[id]! };
};

/** `values` with the layer's values over them. The layer holds only circle-capable keys. */
export const withCircleLayer = <A extends object>(values: A, layer: SettingValues): A =>
  Object.keys(layer).length === 0 ? values : { ...values, ...layer };
