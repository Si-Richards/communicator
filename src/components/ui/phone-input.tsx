import * as React from "react"
import { cn } from "@/lib/utils"
import { Input } from "@/components/ui/input"
import { validatePhoneNumber, formatPhoneNumber, filterNumericInput, type PhoneNumberValidation } from "@/lib/phoneNumberUtils"
import { Check, X, Globe } from "lucide-react"

export interface PhoneInputProps extends Omit<React.ComponentProps<"input">, "onChange"> {
  value: string
  onChange: (value: string, validation: PhoneNumberValidation) => void
  defaultCountry?: string
  showValidation?: boolean
  className?: string
}

const PhoneInput = React.forwardRef<HTMLInputElement, PhoneInputProps>(
  ({ className, value, onChange, defaultCountry = "GB", showValidation = true, ...props }, ref) => {
    const [validation, setValidation] = React.useState<PhoneNumberValidation>({ isValid: false })
    const [isFocused, setIsFocused] = React.useState(false)

    React.useEffect(() => {
      const validationResult = validatePhoneNumber(value, defaultCountry)
      setValidation(validationResult)
    }, [value, defaultCountry])

    const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
      const filteredValue = filterNumericInput(e.target.value)
      const validationResult = validatePhoneNumber(filteredValue, defaultCountry)
      setValidation(validationResult)
      onChange(filteredValue, validationResult)
    }

    const handleFocus = (e: React.FocusEvent<HTMLInputElement>) => {
      setIsFocused(true)
      props.onFocus?.(e)
    }

    const handleBlur = (e: React.FocusEvent<HTMLInputElement>) => {
      setIsFocused(false)
      props.onBlur?.(e)
    }

    const displayValue = isFocused ? value : (validation.formattedNumber || value)

    return (
      <div className="space-y-2">
        <div className="relative">
          <Input
            {...props}
            ref={ref}
            type="tel"
            value={displayValue}
            onChange={handleChange}
            onFocus={handleFocus}
            onBlur={handleBlur}
            className={cn(
              "pr-10",
              validation.isValid && value && "border-green-500 focus-visible:ring-green-500",
              !validation.isValid && value && validation.error && "border-red-500 focus-visible:ring-red-500",
              className
            )}
            placeholder={defaultCountry === "GB" ? "07880 498653" : defaultCountry === "US" ? "(555) 123-4567" : "Phone number"}
          />
          {showValidation && value && (
            <div className="absolute right-3 top-1/2 -translate-y-1/2">
              {validation.isValid ? (
                <Check className="h-4 w-4 text-green-500" />
              ) : (
                <X className="h-4 w-4 text-red-500" />
              )}
            </div>
          )}
        </div>
        
        {value && validation.countryName && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Globe className="h-3 w-3" />
            <span>{validation.countryName}</span>
          </div>
        )}
        
        {!validation.isValid && value && validation.error && (
          <p className="text-sm text-red-500">{validation.error}</p>
        )}
      </div>
    )
  }
)

PhoneInput.displayName = "PhoneInput"

export { PhoneInput }