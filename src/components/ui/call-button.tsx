import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"

const callButtonVariants = cva(
  "inline-flex items-center justify-center whitespace-nowrap rounded-full text-sm font-medium ring-offset-background transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        call: "bg-gradient-call text-call-success-foreground hover:scale-105 shadow-call active:scale-95 transition-call",
        hangup: "bg-gradient-hangup text-call-danger-foreground hover:scale-105 shadow-hangup active:scale-95 transition-call",
        primary: "bg-gradient-primary text-primary-foreground hover:scale-105 shadow-elegant active:scale-95 transition-call",
        outline: "border border-input bg-background hover:bg-accent hover:text-accent-foreground",
        secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/80",
        ghost: "hover:bg-accent hover:text-accent-foreground",
      },
      size: {
        default: "h-12 w-12",
        sm: "h-9 w-9",
        lg: "h-16 w-16",
        xl: "h-20 w-20",
        icon: "h-10 w-10",
      },
    },
    defaultVariants: {
      variant: "call",
      size: "xl",
    },
  }
)

export interface CallButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof callButtonVariants> {
  asChild?: boolean
}

const CallButton = React.forwardRef<HTMLButtonElement, CallButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button"
    return (
      <Comp
        className={cn(callButtonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    )
  }
)
CallButton.displayName = "CallButton"

export { CallButton, callButtonVariants }