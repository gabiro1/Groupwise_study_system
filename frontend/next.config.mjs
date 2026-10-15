/** @type {import('next').NextConfig} */
const nextConfig = {
  async headers() {
    // Jitsi IFrame embedding needs explicit permissions + frame sources.
    // The API (backend) keeps frameAncestors 'none'; only the frontend
    // allows framing the configured Jitsi host. Secrets never ship here —
    // only the public domain allowlist.
    const jitsiDomain = process.env.NEXT_PUBLIC_JITSI_DOMAIN || "meet.jit.si";
    return [
      {
        source: "/dashboard/meetings/:path*",
        headers: [
          {
            key: "Content-Security-Policy",
            value: [
              "default-src 'self'",
              "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://*.jitsi.net https://meet.jit.si",
              `connect-src 'self' https://${jitsiDomain} https://*.jitsi.net wss://*.jitsi.net https://meet.jit.si wss://meet.jit.si`,
              `frame-src 'self' https://${jitsiDomain} https://*.jitsi.net https://meet.jit.si https://8x8.vc https://*.8x8.vc`,
              "img-src 'self' data: blob:",
              "media-src 'self' blob: data:",
              "font-src 'self' data:",
              "style-src 'self' 'unsafe-inline'",
              "worker-src 'self' blob:",
            ].join("; "),
          },
          {
            key: "Permissions-Policy",
            value: "camera=(self), microphone=(self), display-capture=(self), fullscreen=(self)",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
