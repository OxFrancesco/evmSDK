/**
 * Aero TUI theme. Token names follow the opencode TUI convention
 * (background layers, text hierarchy, status colors) with an
 * Aerodrome-blue primary.
 */
export const theme = {
  primary: '#4f8ef7',
  secondary: '#56b6c2',
  accent: '#9d7cd8',
  error: '#e06c75',
  warning: '#f5a742',
  success: '#7fd88f',
  info: '#56b6c2',
  text: '#e6e9f0',
  textMuted: '#7a8194',
  background: '#0a0c10',
  backgroundPanel: '#12151c',
  backgroundElement: '#1b2030',
  border: '#2a3040',
  borderActive: '#3d4660',
  selectedText: '#0a0c10',
} as const

export type Theme = typeof theme
