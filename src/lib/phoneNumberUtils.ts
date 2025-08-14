import { parsePhoneNumber, isValidPhoneNumber, getCountryCallingCode, AsYouType } from 'libphonenumber-js'

export interface PhoneNumberValidation {
  isValid: boolean
  country?: string
  countryName?: string
  formattedNumber?: string
  error?: string
}

const countryNames: Record<string, string> = {
  GB: 'United Kingdom',
  US: 'United States',
  ES: 'Spain',
  CA: 'Canada',
  AU: 'Australia',
  DE: 'Germany',
  FR: 'France',
  IT: 'Italy',
  JP: 'Japan',
  KR: 'South Korea',
  CN: 'China',
  IN: 'India',
  BR: 'Brazil',
  MX: 'Mexico',
  NL: 'Netherlands',
  SE: 'Sweden',
  NO: 'Norway',
  DK: 'Denmark',
  FI: 'Finland',
  BE: 'Belgium',
  CH: 'Switzerland',
  AT: 'Austria',
  IE: 'Ireland',
  PT: 'Portugal',
  GR: 'Greece',
  PL: 'Poland',
  CZ: 'Czech Republic',
  HU: 'Hungary',
  RO: 'Romania',
  BG: 'Bulgaria',
  HR: 'Croatia',
  SI: 'Slovenia',
  SK: 'Slovakia',
  LT: 'Lithuania',
  LV: 'Latvia',
  EE: 'Estonia'
}

export function validatePhoneNumber(number: string, defaultCountry: string = 'GB'): PhoneNumberValidation {
  if (!number || number.trim().length === 0) {
    return {
      isValid: false,
      error: 'Phone number is required'
    }
  }

  // Remove any non-digit characters except +
  const cleanNumber = number.replace(/[^\d+]/g, '')
  
  if (cleanNumber.length === 0) {
    return {
      isValid: false,
      error: 'Please enter a valid phone number'
    }
  }

  try {
    // Try parsing with default country first
    const phoneNumber = parsePhoneNumber(cleanNumber, defaultCountry as any)
    
    if (phoneNumber && isValidPhoneNumber(cleanNumber, defaultCountry as any)) {
      return {
        isValid: true,
        country: phoneNumber.country,
        countryName: getCountryName(phoneNumber.country || defaultCountry),
        formattedNumber: phoneNumber.formatNational()
      }
    }

    // If not valid with default country, try international parsing
    if (cleanNumber.startsWith('+')) {
      const internationalPhoneNumber = parsePhoneNumber(cleanNumber)
      
      if (internationalPhoneNumber && internationalPhoneNumber.isValid()) {
        return {
          isValid: true,
          country: internationalPhoneNumber.country,
          countryName: getCountryName(internationalPhoneNumber.country || defaultCountry),
          formattedNumber: internationalPhoneNumber.formatNational()
        }
      }
    }

    return {
      isValid: false,
      error: `Invalid ${getCountryName(defaultCountry)} phone number`
    }
  } catch (error) {
    return {
      isValid: false,
      error: 'Please enter a valid phone number'
    }
  }
}

export function formatPhoneNumber(number: string, defaultCountry: string = 'GB'): string {
  if (!number) return ''
  
  // Remove any non-digit characters except +
  const cleanNumber = number.replace(/[^\d+]/g, '')
  
  try {
    const formatter = new AsYouType(defaultCountry as any)
    return formatter.input(cleanNumber) || cleanNumber
  } catch (error) {
    return cleanNumber
  }
}

export function detectCountryFromNumber(number: string): string | null {
  if (!number) return null
  
  // Remove any non-digit characters except +
  const cleanNumber = number.replace(/[^\d+]/g, '')
  
  try {
    const phoneNumber = parsePhoneNumber(cleanNumber)
    return phoneNumber?.country || null
  } catch (error) {
    return null
  }
}

export function getCountryName(countryCode: string): string {
  return countryNames[countryCode] || countryCode
}

export function filterNumericInput(value: string): string {
  // Allow only digits and + symbol at the beginning
  return value.replace(/[^\d+]/g, '').replace(/(?!^)\+/g, '')
}