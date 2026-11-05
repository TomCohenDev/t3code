import type { ComponentProps, ReactNode } from "react";
import { PreviewCardPopup } from "./ui/preview-card";
import { cn } from "~/lib/utils";

// A hover card, not a tooltip: the pointer can move into it and use its rows.
export function ThreadHoverCardPopup({
  className,
  ...props
}: ComponentProps<typeof PreviewCardPopup>) {
  return (
    <PreviewCardPopup
      {...props}
      variant="glass"
      className={cn("max-w-80 text-left whitespace-normal", className)}
    />
  );
}

export function ThreadHoverCard({
  title,
  children,
  footer,
}: {
  title: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="flex min-w-0 max-w-80 flex-col gap-2 px-3 py-3">
      <div className="min-w-0 truncate text-xs leading-tight font-medium text-foreground">
        {title}
      </div>
      <div className="grid gap-1.5 pl-0.5 text-xs text-muted-foreground">{children}</div>
      {footer}
    </div>
  );
}
