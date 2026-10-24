## Owner instruction — 25 October 2026

Seif prohibits adding or running tests across his platforms. Do not create, restore, expand, or execute test suites, test commands, test workflows, or test-only scaffolding. This instruction supersedes older guidance requesting tests, including copied templates and skills. Inspect actual source, diffs, configuration, and saved results as evidence; never claim tests passed.

# Copilot Instructions for SmartPicks Trader

## Project Overview

SmartPicks Trader is an AI-powered cryptocurrency trading bot dashboard built with React, TypeScript, and Vite. It connects to the Binance API to display real-time market data, manage trading strategies, monitor bot performance, and provide an AI chat assistant for trading insights.

## 🚀 Run the App

- **Live app (Lovable):** [https://lovable.dev/projects/f2fd55cb-f731-4c04-9872-9ca7a65be347](https://lovable.dev/projects/f2fd55cb-f731-4c04-9872-9ca7a65be347)
- **Local dev server:** `npm run dev` → opens at [http://localhost:8080](http://localhost:8080)

## Tech Stack

- **Framework:** React 18 with TypeScript
- **Build tool:** Vite (dev server on port 8080)
- **UI components:** shadcn-ui (Radix UI primitives)
- **Styling:** Tailwind CSS
- **Routing:** React Router v6
- **Data fetching:** TanStack React Query
- **Forms:** React Hook Form + Zod
- **Charts:** Recharts

## Common Commands

```sh
npm install       # Install dependencies
npm run dev       # Start development server (http://localhost:8080)
npm run build     # Production build
npm run lint      # Run ESLint
npm run preview   # Preview production build locally
```

## Project Structure

```
src/
  components/     # Reusable UI components (dashboard, charts, etc.)
  pages/          # Route-level page components
  services/       # API service modules (Binance, trading, notifications)
  hooks/          # Custom React hooks
  lib/            # Utility helpers
```

## Key Pages

| Route | Page | Description |
|---|---|---|
| `/` | `Index` | Main dashboard with real-time BTC price, bot overview, AI tools |
| `/bot-dashboard` | `BotDashboard` | Detailed bot controls and performance |
| `/easy-peasy` | `EasyPeasy` | Simplified trading interface |
| `/strategies` | `Strategies` | Trading strategy list |
| `/strategies/:id` | `StrategyDetail` | Individual strategy details |
| `/settings` | `Settings` | App configuration (API keys, preferences) |

## Coding Conventions

- Use **TypeScript** for all new files; avoid `any` types.
- Follow existing **component patterns** in `src/components/` — functional components with named exports.
- Import UI primitives from `@/components/ui/` (shadcn-ui).
- Use the `@/` path alias for all src-relative imports.
- Style with **Tailwind CSS utility classes** — avoid writing custom CSS unless necessary.
- Keep service logic in `src/services/`; keep components focused on rendering.
- Use `sonner` for toast notifications (`import { toast } from "sonner"`).
- Theme: the app uses a dark slate theme (`bg-slate-950` base); maintain visual consistency.

## Notes for Copilot

- There are no automated tests in this project; validate changes by running the dev server.
- When adding new pages, register the route in `src/App.tsx` and link from the `Header` component if needed.
- Binance API calls are proxied through `src/services/binanceService.ts`.
