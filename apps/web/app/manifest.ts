import type { MetadataRoute } from 'next';

// Installable as a home-screen app (CLAUDE.md §Architecture).
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'CANUTELL',
    short_name: 'CANUTELL',
    start_url: '/',
    display: 'standalone',
    background_color: '#14161a',
    theme_color: '#14161a',
    icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml' }],
  };
}
