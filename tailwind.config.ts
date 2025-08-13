import type { Config } from "tailwindcss";

export default {
	darkMode: ["class"],
	content: [
		"./pages/**/*.{ts,tsx}",
		"./components/**/*.{ts,tsx}",
		"./app/**/*.{ts,tsx}",
		"./src/**/*.{ts,tsx}",
	],
	prefix: "",
	theme: {
		container: {
			center: true,
			padding: '2rem',
			screens: {
				'2xl': '1400px'
			}
		},
		extend: {
			colors: {
				border: 'hsl(var(--border))',
				input: 'hsl(var(--input))',
				ring: 'hsl(var(--ring))',
				background: 'hsl(var(--background))',
				foreground: 'hsl(var(--foreground))',
				primary: {
					DEFAULT: 'hsl(var(--primary))',
					foreground: 'hsl(var(--primary-foreground))'
				},
				secondary: {
					DEFAULT: 'hsl(var(--secondary))',
					foreground: 'hsl(var(--secondary-foreground))'
				},
				destructive: {
					DEFAULT: 'hsl(var(--destructive))',
					foreground: 'hsl(var(--destructive-foreground))'
				},
				muted: {
					DEFAULT: 'hsl(var(--muted))',
					foreground: 'hsl(var(--muted-foreground))'
				},
				accent: {
					DEFAULT: 'hsl(var(--accent))',
					foreground: 'hsl(var(--accent-foreground))'
				},
				popover: {
					DEFAULT: 'hsl(var(--popover))',
					foreground: 'hsl(var(--popover-foreground))'
				},
				card: {
					DEFAULT: 'hsl(var(--card))',
					foreground: 'hsl(var(--card-foreground))'
				},
				call: {
					success: 'hsl(var(--call-success))',
					'success-foreground': 'hsl(var(--call-success-foreground))',
					danger: 'hsl(var(--call-danger))',
					'danger-foreground': 'hsl(var(--call-danger-foreground))',
					warning: 'hsl(var(--call-warning))',
					'warning-foreground': 'hsl(var(--call-warning-foreground))'
				},
				status: {
					connected: 'hsl(var(--status-connected))',
					connecting: 'hsl(var(--status-connecting))',
					disconnected: 'hsl(var(--status-disconnected))',
					error: 'hsl(var(--status-error))'
				}
			},
			backgroundImage: {
				'gradient-call': 'var(--gradient-call)',
				'gradient-hangup': 'var(--gradient-hangup)',
				'gradient-primary': 'var(--gradient-primary)'
			},
			boxShadow: {
				'call': 'var(--shadow-call)',
				'hangup': 'var(--shadow-hangup)',
				'elegant': 'var(--shadow-elegant)'
			},
			transitionProperty: {
				'smooth': 'var(--transition-smooth)',
				'call': 'var(--transition-call)'
			},
			borderRadius: {
				lg: 'var(--radius)',
				md: 'calc(var(--radius) - 2px)',
				sm: 'calc(var(--radius) - 4px)'
			},
			keyframes: {
				'accordion-down': {
					from: {
						height: '0'
					},
					to: {
						height: 'var(--radix-accordion-content-height)'
					}
				},
				'accordion-up': {
					from: {
						height: 'var(--radix-accordion-content-height)'
					},
					to: {
						height: '0'
					}
				}
			},
			animation: {
				'accordion-down': 'accordion-down 0.2s ease-out',
				'accordion-up': 'accordion-up 0.2s ease-out'
			}
		}
	},
	plugins: [require("tailwindcss-animate")],
} satisfies Config;
