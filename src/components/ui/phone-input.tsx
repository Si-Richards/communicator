import * as React from "react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { detectCountryFromNumber, getCountryName, filterPhoneInput, validatePhoneNumber } from "@/lib/phoneNumberUtils";

export interface PhoneInputProps extends Omit<React.ComponentProps<"input">, "onChange"> {
  value: string;
  onChange: (value: string) => void;
  onCountryChange?: (country: string) => void;
}

const PhoneInput = React.forwardRef<HTMLInputElement, PhoneInputProps>(
  ({ className, value, onChange, onCountryChange, ...props }, ref) => {
    const [detectedCountry, setDetectedCountry] = React.useState('GB');
    const [isValid, setIsValid] = React.useState(true);

    React.useEffect(() => {
      const country = detectCountryFromNumber(value);
      setDetectedCountry(country);
      setIsValid(value === '' || validatePhoneNumber(value));
      onCountryChange?.(getCountryName(country));
    }, [value, onCountryChange]);

    const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
      const filtered = filterPhoneInput(e.target.value);
      onChange(filtered);
    };

    return (
      <div className="space-y-2">
        <Input
          ref={ref}
          type="tel"
          value={value}
          onChange={handleChange}
          className={cn(
            "text-center text-lg",
            !isValid && value !== '' && "border-destructive focus-visible:ring-destructive",
            className
          )}
          {...props}
        />
        {value && (
          <div className="text-sm text-muted-foreground text-center">
            {getCountryName(detectedCountry as any)}
          </div>
        )}
      </div>
    );
  }
);

PhoneInput.displayName = "PhoneInput";

export { PhoneInput };