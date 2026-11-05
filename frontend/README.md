This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://github.com/vercel/next.js/tree/canary/packages/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.js`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to optimize and load Poppins.

## Lien student dashboard

The authenticated dashboard includes group recommendations, student profile and
study settings, notifications, and collaborative group workspaces. Workspace
pages support plans, tasks, sessions, group chat, link/text resources, learning
progress, group feedback, and an AI assistant grounded in accessible group
material. File uploads are not available in group workspaces yet.

## Backend connection

The dashboard and its API proxy require the Lien backend. Set
`BACKEND_API_URL` when the backend is not running at `http://localhost:4000`
(see `.env.example`). This is a **server-only** variable: the browser calls
same-origin `/api/*`, and the Next.js route handlers proxy to the backend, so
no `NEXT_PUBLIC_*` or `VITE_*` variable is involved.

Check the connection from the app itself with `GET /api/health`; it reports
whether the Next.js server can reach the backend and database.

Workspace links use `/dashboard/workspaces/[workspaceId]`.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

This repository contains two apps. Create the Vercel project from the repo
root, then use these settings:

| Setting | Value |
| --- | --- |
| Root Directory | `frontend` |
| Framework Preset | Next.js |
| Install Command | `npm install` |
| Build Command | `npm run build` |
| Output Directory | *(leave default)* |

Add one environment variable for **Production** (and Preview if you use it):

```
BACKEND_API_URL=https://<your-render-service>.onrender.com
```

This is optional: when unset in production, the frontend falls back to
`https://groupwise-study-system.onrender.com`. Set it explicitly to override
that fallback for staging or a custom backend domain. Do not add `/api` to the
end, and do not prefix the name with `NEXT_PUBLIC_`. Vercel only injects
environment variables at build/runtime, so redeploy after changing it.

On the Render backend, set `APP_URL` to the Vercel URL, `COOKIE_SECURE=true`,
`TRUST_PROXY=true`, and `CORS_ORIGINS` to the exact Vercel origin (plus any
custom domain). `COOKIE_DOMAIN` must stay unset when the frontend and backend
are on different domains and all browser traffic goes through the BFF.

Check out the [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for details.
