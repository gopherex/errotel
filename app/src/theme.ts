import { createTheme } from '@mantine/core'

// Adapted from HyperDX fda038d630ef66963d90399648dc7d107c0ca69f.
// Copyright (c) 2023 DeploySentinel, Inc. MIT: vendor/hyperdx/LICENSE.
export const theme = createTheme({
  primaryColor: 'green',
  primaryShade: 4,
  defaultRadius: 'sm',
  fontFamily: '"IBM Plex Sans", sans-serif',
  fontFamilyMonospace: '"IBM Plex Mono", monospace',
  fontSizes: { xxs: '11px', xs: '12px', sm: '13px', md: '15px', lg: '16px', xl: '18px' },
  spacing: { xxxs: '6px', xxs: '8px', xs: '10px', sm: '12px', md: '16px', lg: '20px', xl: '32px' },
  colors: {
    green: [
      '#eafff6',
      '#cdfee7',
      '#a0fad5',
      '#63f2bf',
      '#25e2a5',
      '#00c28a',
      '#00a475',
      '#008362',
      '#00674e',
      '#005542',
    ],
    dark: [
      '#C1C2C5',
      '#A6A7AB',
      '#909296',
      '#5C5F66',
      '#373A40',
      '#2C2E33',
      '#25262B',
      '#1A1B1E',
      '#141517',
      '#101113',
    ],
  },
})
