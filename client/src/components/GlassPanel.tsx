/**
 * GlassPanel — Reusable frosted glass container
 * Design: Obsidian Prism — translucent panels with purple-tinted borders
 */
import { type ReactNode } from "react";
import { cn } from "@/lib/utils";

interface GlassPanelProps {
  children: ReactNode;
  className?: string;
  title?: string;
  subtitle?: string;
  icon?: ReactNode;
  action?: ReactNode;
  noPadding?: boolean;
  poweredBy?: string;
}

export default function GlassPanel({
  children,
  className,
  title,
  subtitle,
  icon,
  action,
  noPadding,
  poweredBy,
}: GlassPanelProps) {
  return (
    <div
      className={cn(
        "glass-panel rounded-lg overflow-hidden",
        className
      )}
    >
      {(title || action) && (
        <div className="flex items-center justify-between px-4 py-3 border-b border-border/30">
          <div className="flex items-center gap-2.5">
            {icon && <span className="text-primary">{icon}</span>}
            <div>
              <h3 className="text-sm font-semibold font-display tracking-wide text-foreground">
                {title}
              </h3>
              {subtitle && (
                <p className="text-[11px] font-mono text-muted-foreground mt-0.5">
                  {subtitle}
                </p>
              )}
            </div>
          </div>
          {action && <div className="flex items-center gap-2">{action}</div>}
        </div>
      )}
      <div className={cn(noPadding ? "" : "p-4")}>{children}</div>
      {poweredBy && (
        <div className="px-4 py-2 border-t border-border/20">
          <span className="text-[10px] font-mono text-muted-foreground/60">
            Powered by: {poweredBy}
          </span>
        </div>
      )}
    </div>
  );
}
