import { PreviewCard as PreviewCardPrimitive } from "@base-ui/react/preview-card";
import { createContext, use, useRef, useState, type RefObject } from "react";

import { cn } from "~/lib/utils";
import { useNativeTitlebarHeight } from "~/lib/windowControlsOverlay";

// Base UI's default, restated because a padding object zeroes the sides it omits.
const COLLISION_PADDING = 5;

// Shorter than Base UI's 600ms so a card feels like a tooltip; closeDelay covers the
// pointer's trip from the trigger into the card.
const OPEN_DELAY = 350;
const CLOSE_DELAY = 150;

type PreviewCardActionsRef = RefObject<PreviewCardPrimitive.Root.Actions | null>;
const PreviewCardActionsContext = createContext<{
  actionsRef: PreviewCardActionsRef;
  nestedOpen: boolean;
  setNestedOpen: (open: boolean) => void;
} | null>(null);

function PreviewCard<Payload>(props: PreviewCardPrimitive.Root.Props<Payload>) {
  const localActionsRef = useRef<PreviewCardPrimitive.Root.Actions | null>(null);
  const actionsRef = props.actionsRef ?? localActionsRef;
  const parent = use(PreviewCardActionsContext);
  // A card whose trigger sits inside another card's trigger (the PR chip in a thread row)
  // hides the outer card while it is open, so only one card shows at a time.
  const [nestedOpen, setNestedOpen] = useState(false);
  return (
    <PreviewCardActionsContext value={{ actionsRef, nestedOpen, setNestedOpen }}>
      <PreviewCardPrimitive.Root
        {...props}
        actionsRef={actionsRef}
        onOpenChange={(open, details) => {
          props.onOpenChange?.(open, details);
          parent?.setNestedOpen(open);
        }}
      />
    </PreviewCardActionsContext>
  );
}

function PreviewCardTrigger({
  delay = OPEN_DELAY,
  closeDelay = CLOSE_DELAY,
  ...props
}: PreviewCardPrimitive.Trigger.Props) {
  const card = use(PreviewCardActionsContext);
  return (
    <PreviewCardPrimitive.Trigger
      data-slot="preview-card-trigger"
      delay={delay}
      closeDelay={closeDelay}
      {...props}
      // Base UI keeps the card open on press; a trigger press here navigates or opens
      // a panel, so the card leaves with it.
      onClick={(event) => {
        props.onClick?.(event);
        card?.actionsRef.current?.close();
      }}
    />
  );
}

function PreviewCardPopup({
  className,
  align = "start",
  side = "top",
  sideOffset = 6,
  variant = "default",
  ...props
}: PreviewCardPrimitive.Popup.Props & {
  align?: PreviewCardPrimitive.Positioner.Props["align"];
  side?: PreviewCardPrimitive.Positioner.Props["side"];
  sideOffset?: PreviewCardPrimitive.Positioner.Props["sideOffset"];
  variant?: "default" | "glass";
}) {
  const titlebarHeight = useNativeTitlebarHeight();
  const card = use(PreviewCardActionsContext);
  if (card?.nestedOpen) return null;
  return (
    <PreviewCardPrimitive.Portal>
      <PreviewCardPrimitive.Positioner
        align={align}
        className="z-[140] max-w-(--available-width)"
        collisionPadding={{
          top: COLLISION_PADDING + titlebarHeight,
          right: COLLISION_PADDING,
          bottom: COLLISION_PADDING,
          left: COLLISION_PADDING,
        }}
        data-slot="preview-card-positioner"
        side={side}
        sideOffset={sideOffset}
      >
        <PreviewCardPrimitive.Popup
          className={cn(
            "origin-(--transform-origin) text-popover-foreground outline-none transition-[scale,opacity] data-ending-style:scale-98 data-starting-style:scale-98 data-ending-style:opacity-0 data-starting-style:opacity-0",
            // Rounder, with a firmer edge and deeper shadow than a glass tooltip, so a card
            // reads as a surface the pointer can enter.
            variant === "glass"
              ? "dropdown-glass rounded-lg border-foreground/20 text-xs shadow-2xl shadow-black/35"
              : "rounded-lg border bg-popover shadow-lg",
            className,
          )}
          data-slot="preview-card-popup"
          {...props}
        />
      </PreviewCardPrimitive.Positioner>
    </PreviewCardPrimitive.Portal>
  );
}

export { PreviewCard, PreviewCardPopup, PreviewCardTrigger };
