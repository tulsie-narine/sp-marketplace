# AGENTS.md

## Project Identity
This repository is a Lovable-originated ScalePad App Marketplace built with React and TypeScript.

The application hosts multiple internal “mini-apps” (e.g., Initiative Manager, Goal Manager, Opportunities) that share a common UI shell, routing model, and API access pattern.

Your job as an agent is to **extend the system without breaking consistency**.

Do NOT redesign, restructure, or abstract broadly unless explicitly instructed.

---

## Core Principles

1. **Consistency over creativity**
   - Match existing patterns exactly.
   - Prefer copying and adapting over inventing new structures.

2. **Local changes only**
   - Only modify what the task requires.
   - Do not refactor unrelated code.

3. **Preserve UX patterns**
   - The marketplace experience must feel unified across all mini-apps.

4. **Follow the working pattern**
   - If Initiative Manager or Goal Manager already solves a similar problem, reuse that pattern.

---

## Tech Stack

- Vite
- React
- TypeScript
- Tailwind CSS
- shadcn/ui
- React Router (`react-router-dom`)
- TanStack React Query
- Supabase (Auth + Edge Functions)
- React Hook Form + Zod
- Sonner (toasts)
- Lucide React (icons)
- Recharts (charts)

---

## App Shell & Providers

The root app uses a fixed provider stack. Do NOT change this.

Order:
- QueryClientProvider
- TooltipProvider
- Sonner
- AuthProvider
- AppStoreProvider
- BrowserRouter

Reference:
- `src/App.tsx`

---

## Routing Rules

Preserve existing routes:

- `/login`
- `/marketplace`
- `/marketplace/:appId`
- `/admin`
- `/settings`

Auth is enforced via `ProtectedRoute`.

- `/admin` is admin-only
- other routes require authenticated users

Do NOT change route structure or auth gating unless explicitly asked.

---

## Marketplace App Pattern

All mini-apps are rendered through:

- `src/pages/AppDetail.tsx`

This file is the **central dispatcher**.

Responsibilities:
- Read `appId` from route
- Fetch app metadata from AppStoreContext
- Render the correct workspace component:
  - InitiativeManagerWorkspace
  - GoalManagerWorkspace
  - OpportunitiesWorkspace
  - or fallback
- Mount shared UI (ratings/comments, recent apps)

### Rule:
When adding a new app:
- Plug into this same pattern
- Do NOT create a separate routing system
- Keep app-detail page structure intact

---

## Workspace Architecture (CRITICAL)

Reference files:
- `InitiativeManagerWorkspace.tsx`
- `GoalManagerWorkspace.tsx`

All complex mini-apps follow this structure:

### Layout
- Two-panel layout:
  - Left: Library (table/list)
  - Right: Builder / Editor

### Behavior Patterns
- Search + filters above tables
- Client-side filtering when data is already loaded
- Pagination (8 rows per page)
- Row selection + bulk actions
- Modal-driven actions (deploy, delete, confirm)
- Toast feedback (success/error)
- Inline editing where appropriate
- Progress tracking for long operations

### Rule:
Do NOT introduce new layout paradigms for mini-apps.

---

## Pagination & Filtering

Standard pattern:

- `PAGE_SIZE = 8`
- Client-side pagination
- Reset page on filter/search change
- Preserve selections across pages for bulk actions

Always match existing table behavior before introducing changes.

---

## Deployment / Orchestration Rules

### Initiative Manager
6-step orchestration:
1. Create shell
2. Set status
3. Set priority
4. Set schedule
5. Set budget
6. Set recurring

### Goal Manager
2-step orchestration:
1. Create goal
2. Update details

### Rules:
- Preserve explicit step-by-step orchestration
- Show progress to user
- Do NOT collapse into a single opaque call
- Maintain error handling per step
- Maintain summary feedback

---

## API Rules (VERY IMPORTANT)

All ScalePad API calls MUST:

- Go through Supabase Edge Function: `scalepad-proxy`
- Use header: `x-scalepad-api-key`
- Use existing helper files:
  - `src/lib/initiative-api.ts`
  - `src/lib/goal-api.ts`

### DO NOT:
- Call ScalePad APIs directly
- Bypass the edge proxy
- Change auth header format
- Store raw API keys anywhere

### Data Fetching
- Use existing helper functions
- Preserve cursor-based pagination logic (fetch-all patterns)

---

## Auth & Identity

- API key comes from session storage
- User identity for feedback uses SHA-256 hashing
- Supabase Auth is used for admin login

### Rules:
- Never store raw API keys
- Do not modify auth flow unless explicitly requested

---

## UI & Design Rules

- Maintain dark theme
- Use existing Tailwind + shadcn patterns
- Reuse existing components first
- Match spacing, typography, and interaction patterns

### Do NOT:
- Introduce a new design system
- Mix inconsistent UI patterns
- Over-abstract UI components

---

## Feedback System

- Ratings + comments exist on app detail pages
- Admin can delete comments
- Uses Supabase + edge function

### Rule:
Preserve this system and integrate new apps into it automatically

---

## Code Style & Implementation Approach

Before coding:

1. Find the closest existing implementation
2. Copy structure
3. Adapt minimally
4. Keep naming consistent
5. Keep logic readable

### Prefer:
- Explicit code over abstraction
- Consistency over optimization
- Small diffs over large rewrites

---

## Golden Reference Files

Always review before making changes:

- `src/App.tsx`
- `src/pages/AppDetail.tsx`
- `src/components/workspace/InitiativeManagerWorkspace.tsx`
- `src/components/workspace/GoalManagerWorkspace.tsx`
- `src/lib/initiative-api.ts`
- `src/lib/goal-api.ts`

These define the system’s patterns.

---

## Commands

Use npm scripts:

- `npm run dev`
- `npm run build`
- `npm run lint`
- `npm run preview`
- `npm run test`
- `npm run test:watch`

---

## Definition of Done

A task is complete when:

- It works within the existing architecture
- UI matches marketplace patterns
- Pagination/filter behavior is consistent
- API calls follow proxy + auth rules
- Errors are clearly handled
- No unnecessary refactoring occurred
- Existing apps remain unchanged unless required

---

## Change Guardrails

DO NOT:

- Restructure the app shell
- Replace routing patterns
- Introduce new architectural paradigms
- Modify API contracts without instruction
- Break workspace consistency

ALWAYS:

- Extend existing patterns
- Keep behavior predictable
- Maintain system coherence