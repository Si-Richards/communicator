import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"

const statusIndicatorVariants = cva(
  "inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-medium transition-smooth",
  {
    variants: {
      variant: {
        connected: "bg-status-connected/10 text-status-connected border border-status-connected/20",
        connecting: "bg-status-connecting/10 text-status-connecting border border-status-connecting/20",
        disconnected: "bg-status-disconnected/10 text-status-disconnected border border-status-disconnected/20",
        error: "bg-status-error/10 text-status-error border border-status-error/20",
      },
    },
    defaultVariants: {
      variant: "disconnected",
    },
  }
)

const statusDotVariants = cva(
  "w-2 h-2 rounded-full transition-smooth",
  {
    variants: {
      variant: {
        connected: "bg-status-connected animate-pulse",
        connecting: "bg-status-connecting animate-ping",
        disconnected: "bg-status-disconnected",
        error: "bg-status-error animate-pulse",
      },
    },
    defaultVariants: {
      variant: "disconnected",
    },
  }
)

export interface StatusIndicatorProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof statusIndicatorVariants> {
  label: string
}

const StatusIndicator = React.forwardRef<HTMLDivElement, StatusIndicatorProps>(
  ({ className, variant, label, ...props }, ref) => {
    return (
      <div
        className={cn(statusIndicatorVariants({ variant, className }))}
        ref={ref}
        {...props}
      >
        <div className={cn(statusDotVariants({ variant }))} />
        {label}
      </div>
    )
  }
)
StatusIndicator.displayName = "StatusIndicator"

export { StatusIndicator, statusIndicatorVariants }