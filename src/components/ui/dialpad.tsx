import * as React from "react"
import { Delete } from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"

interface DialpadProps {
  onDigitPress: (digit: string) => void
  onBackspace: () => void
  className?: string
}

const dialpadKeys = [
  ['1', '2', '3'],
  ['4', '5', '6'], 
  ['7', '8', '9'],
  ['*', '0', '#']
]

const Dialpad = React.forwardRef<HTMLDivElement, DialpadProps>(
  ({ onDigitPress, onBackspace, className }, ref) => {
    const handleKeyPress = (key: string) => {
      onDigitPress(key)
      
      // Add haptic feedback for mobile devices
      if (navigator.vibrate) {
        navigator.vibrate(50)
      }
    }

    const handleBackspace = () => {
      onBackspace()
      
      // Add haptic feedback for mobile devices
      if (navigator.vibrate) {
        navigator.vibrate(30)
      }
    }

    return (
      <div 
        ref={ref}
        className={cn("w-full max-w-xs mx-auto space-y-3", className)}
      >
        {/* Dialpad Grid */}
        <div className="grid grid-cols-3 gap-3">
          {dialpadKeys.map((row, rowIndex) =>
            row.map((key) => (
              <Button
                key={key}
                variant="outline"
                size="lg"
                onClick={() => handleKeyPress(key)}
                className="h-14 w-full text-xl font-semibold rounded-full hover:scale-105 active:scale-95 transition-all duration-150 bg-card hover:bg-accent"
              >
                {key}
              </Button>
            ))
          )}
        </div>
        
        {/* Backspace Button */}
        <div className="flex justify-center">
          <Button
            variant="ghost"
            size="lg"
            onClick={handleBackspace}
            className="h-12 w-12 rounded-full hover:bg-accent/50 transition-colors"
          >
            <Delete className="h-5 w-5" />
          </Button>
        </div>
      </div>
    )
  }
)

Dialpad.displayName = "Dialpad"

export { Dialpad }