/** @type {import('next').NextConfig} */
const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
];

const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Analítica pasó de 5 páginas a una sola pantalla con pestañas: las rutas viejas siguen funcionando (con sus
  // filtros: Next conserva la query) para no romper marcadores ni enlaces ya compartidos.
  async redirects() {
    return [
      { source: '/dashboard', destination: '/analytics', permanent: true },
      { source: '/funnel', destination: '/analytics/embudo', permanent: true },
      { source: '/performance', destination: '/analytics/desempeno', permanent: true },
      { source: '/reports', destination: '/analytics/reportes', permanent: true },
      { source: '/reports/widget', destination: '/analytics/widget', permanent: true },
    ];
  },
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

export default nextConfig;
