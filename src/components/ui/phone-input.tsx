import * as React from "react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { detectCountryFromNumber, getCountryName, getCountryFlag, filterPhoneInput, validatePhoneNumber } from "@/lib/phoneNumberUtils";
import { CountryCode } from 'libphonenumber-js';

export interface PhoneInputProps extends Omit<React.ComponentProps<"input">, "onChange"> {
  value: string;
  onChange: (value: string) => void;
  onCountryChange?: (country: string) => void;
}

const PhoneInput = React.forwardRef<HTMLInputElement, PhoneInputProps>(
  ({ className, value, onChange, onCountryChange, ...props }, ref) => {
    const [detectedCountry, setDetectedCountry] = React.useState<CountryCode | null>(null);
    const [isValid, setIsValid] = React.useState(true);

    React.useEffect(() => {
      const country = detectCountryFromNumber(value);
      setDetectedCountry(country);
      setIsValid(value === '' || validatePhoneNumber(value));
      if (country) {
        onCountryChange?.(getCountryName(country));
      }
    }, [value, onCountryChange]);

    const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
      const filtered = filterPhoneInput(e.target.value);
      onChange(filtered);
    };

    return (
      <div className="space-y-2">
        {detectedCountry && (
          <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
            <span className="text-lg">{getCountryFlag(detectedCountry)}</span>
            <span>{getCountryName(detectedCountry)}</span>
          </div>
        )}
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
      </div>
    );
  }
);

PhoneInput.displayName = "PhoneInput";

export { PhoneInput };