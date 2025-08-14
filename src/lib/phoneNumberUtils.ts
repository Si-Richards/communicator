import { parsePhoneNumber, getCountries, getCountryCallingCode, CountryCode } from 'libphonenumber-js';

// Country code to name mapping for major countries
const countryNames: Record<string, string> = {
  'US': 'United States',
  'CA': 'Canada',
  'GB': 'United Kingdom',
  'DE': 'Germany',
  'FR': 'France',
  'IT': 'Italy',
  'ES': 'Spain',
  'NL': 'Netherlands',
  'BE': 'Belgium',
  'AU': 'Australia',
  'NZ': 'New Zealand',
  'JP': 'Japan',
  'CN': 'China',
  'IN': 'India',
  'BR': 'Brazil',
  'MX': 'Mexico',
  'AR': 'Argentina',
  'RU': 'Russia',
  'ZA': 'South Africa',
  'EG': 'Egypt',
  'NG': 'Nigeria',
  'KE': 'Kenya',
  'SE': 'Sweden',
  'NO': 'Norway',
  'DK': 'Denmark',
  'FI': 'Finland',
  'PL': 'Poland',
  'CZ': 'Czech Republic',
  'AT': 'Austria',
  'CH': 'Switzerland',
  'IE': 'Ireland',
  'PT': 'Portugal',
  'GR': 'Greece',
  'TR': 'Turkey',
  'IL': 'Israel',
  'AE': 'United Arab Emirates',
  'SA': 'Saudi Arabia',
  'KR': 'South Korea',
  'TH': 'Thailand',
  'SG': 'Singapore',
  'MY': 'Malaysia',
  'PH': 'Philippines',
  'ID': 'Indonesia',
  'VN': 'Vietnam'
};

/**
 * Validates if a phone number is valid
 */
export function validatePhoneNumber(number: string): boolean {
  if (!number.trim()) return false;
  
  try {
    const phoneNumber = parsePhoneNumber(number, 'GB'); // Default to GB
    return phoneNumber.isValid();
  } catch {
    return false;
  }
}

/**
 * Detects country from phone number, returns 'GB' as default
 */
export function detectCountryFromNumber(number: string): CountryCode {
  if (!number.trim()) return 'GB';
  
  // If number starts with +, try to parse as international
  if (number.startsWith('+')) {
    try {
      const phoneNumber = parsePhoneNumber(number);
      return phoneNumber?.country || 'GB';
    } catch {
      return 'GB';
    }
  }
  
  // For non-international numbers, default to UK
  return 'GB';
}

/**
 * Gets country name from country code
 */
export function getCountryName(countryCode: CountryCode): string {
  return countryNames[countryCode] || countryCode;
}

/**
 * Formats phone number for display
 */
export function formatPhoneNumber(number: string, country: CountryCode = 'GB'): string {
  if (!number.trim()) return number;
  
  try {
    const phoneNumber = parsePhoneNumber(number, country);
    return phoneNumber.formatInternational();
  } catch {
    return number;
  }
}

/**
 * Filters input to only allow numeric characters and + for international
 */
export function filterPhoneInput(input: string): string {
  // Allow + only at the beginning, then only digits
  return input.replace(/[^+\d]/g, '').replace(/(?!^)\+/g, '');
}