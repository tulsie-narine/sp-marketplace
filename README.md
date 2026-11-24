# ScalePad App Marketplace

The ScalePad App Marketplace is an authenticated React application for discovering and running internal ScalePad productivity tools. Each tool is presented as a marketplace app with its own description, API information, workspace, ratings, and comments, while sharing the same navigation, authentication, and UI patterns.

## App catalog

The marketplace ships with eight registered apps:

| App | Category | What it does |
| --- | --- | --- |
| **List Opportunities** | Reporting | Loads sales opportunities from ScalePad and shows client, opportunity, and sales-stage information. |
| **Initiative Manager** | Planning | Builds or clones an initiative template and deploys it to multiple clients with step-by-step progress. |
| **Goal Manager** | Planning | Builds or clones a goal and deploys it across selected clients with progress and error feedback. |
| **Tenant Migration** | Utilities | Maps clients between two ScalePad tenants and migrates selected Lifecycle Manager data with retries and an error log. |
| **Client Clean Up** | Utilities | Permanently removes selected Lifecycle Manager data for selected clients by object type. |
| **ControlMap to LMX Workstream Sync** | Reporting | Reviews ControlMap risks and action items, then syncs selected priorities into Lifecycle Manager initiatives or action items. |
| **LCM Data Reset** | Utilities | Runs a controlled Lifecycle Manager reset workflow based on the tenant migration and cleanup orchestration. |
| **PSA Role Sync** | Utilities | Maps ConnectWise, Autotask or HaloPSA team roles to ScalePad CS account roles and assigns matching team members to each client, on a monthly schedule. |

All eight apps are seeded in [`src/lib/mock-data.ts`](src/lib/mock-data.ts). App metadata includes the name, description, category, status, version, API endpoint, and workspace type. New apps can be added from the admin area and are persisted in the browser under the `sp_apps` key.

## Highlights

- Search and filter the catalog by name, description, or category.
- Shared app detail pages with app metadata, ratings, comments, and a workspace selected by app type.
- User access with a ScalePad API key and admin access through Supabase Auth.
- Multi-client workflows with selection, pagination, progress tracking, retries, summaries, and error logs.
- Initiative and goal deployment orchestration through the Lifecycle Manager API.
- Tenant migration, client cleanup, and Lifecycle Manager reset utilities.
- Risk reporting and roadmap creation across the client portfolio.
- Admin registry management: add, edit, activate/deactivate, delete, and restore default apps.

## Tech stack

- React 18 and TypeScript
- Vite
- React Router
- Tailwind CSS and shadcn/ui
- TanStack React Query
- Supabase Auth, database access, and Edge Functions
- Vitest and Testing Library
- Playwright configuration for browser-level testing

## Requirements

- Node.js 18 or newer
- npm (or Bun, if preferred)
- A Supabase project for authentication and Edge Functions
- A valid ScalePad API key for user access

## Local development

1. Install dependencies:

   ```bash
   npm install
   ```

2. Create a local environment file named `.env.local`:

   ```dotenv
   VITE_SUPABASE_URL=https://your-project.supabase.co
   VITE_SUPABASE_PUBLISHABLE_KEY=your-supabase-publishable-key
   ```

3. Start the development server:

   ```bash
   npm run dev
   ```

4. Open the local URL printed by Vite, normally `http://localhost:5173`.

The login screen supports two access modes:

- **User:** enter a ScalePad API key. The key is kept in `sessionStorage` for the current browser session and is sent to the backend proxy only when an app makes an API request.
- **Admin:** sign in or create an admin account through Supabase Auth. Admins can manage the marketplace registry and moderate feedback.

## Supabase setup

The repository includes these Edge Functions:

| Function | Purpose |
| --- | --- |
| `scalepad-proxy` | Proxies ScalePad requests and attaches the session API key without exposing direct API calls in the browser. |
| `app-feedback` | Stores ratings and comments and supports admin moderation. |
| `lcm-data-reset-cron` | Provides the Lifecycle Manager reset runner used by the reset workflow. |
| `user-vault` | Saves a user's ScalePad key and generic scheduled tasks, scoped to a hash of the key. |
| `risk-roadmap-sync` | Runs the ControlMap to LMX Workstream Sync, manually or on schedule. |
| `psa-role-sync` | Stores the encrypted PSA connection and runs PSA Role Sync, manually or on schedule. |

Apply the SQL migrations in `supabase/migrations`, configure the Supabase URL and publishable key, and deploy the functions for a connected environment. Functions that use the Supabase service role require the `SUPABASE_SERVICE_ROLE_KEY` secret to be configured in Supabase; never commit that secret or a ScalePad API key.

### PSA Role Sync setup

`psa-role-sync` needs one extra function secret, `PSA_CREDENTIALS_KEY`: a long random string used to encrypt saved PSA secrets (the ConnectWise private key, Autotask API secret or Halo client secret). Set it before anyone connects, and don't change it afterwards, because saved connections can't be decrypted with a new key.

```bash
supabase secrets set PSA_CREDENTIALS_KEY="$(openssl rand -base64 48)"
```

Scheduled runs need a daily pg_cron job that calls the function with the service-role key. The SQL is in a comment at the end of `supabase/migrations/20261124000000_psa_role_sync.sql`. The function itself skips tasks whose interval (30 days by default) hasn't passed.

The user first picks their PSA: ConnectWise, Autotask or HaloPSA. How a run works:

1. Reads ScalePad clients and takes each client's PSA company ID from `record_lineage`, matched on the vendor's brand name.
2. Reads the PSA's members and the team of every linked client:
   - **ConnectWise:** each company's Team tab, where every member has a team role.
   - **Autotask:** Company Teams have no role, so the company's Account Manager (`ownerResourceID`) gets an "Account Manager (company owner)" role, and each Company Team member gets their default Autotask role (`ResourceRoleDepartments.isDefault`).
   - **HaloPSA:** there is no client team list. Each client's three agent slots, `accountmanagertech`, `pritech` and `sectech`, are the roles (Account Manager, Primary Technician, Secondary Technician). Client reads are paced to stay under Halo's 700 requests per 5 minutes.
3. Matches members to ScalePad users by email, or by an override set in the Members tab.
4. Assigns each matched member to the client's account team with the mapped role (`PUT /app/v1/clients/account-team`).

The sync only adds assignments. Unmatched members, unmapped roles, role conflicts and per-client failures are reported in the run, so they never stop it. The matching and planning logic lives in `supabase/functions/psa-role-sync/plan.ts`, and its tests are in `src/lib/psa-role-sync-plan.test.ts`.

## Routes

| Route | Access | Description |
| --- | --- | --- |
| `/login` | Public | User API-key login and admin authentication. |
| `/marketplace` | Authenticated | Searchable app catalog and marketplace statistics. |
| `/marketplace/:appId` | Authenticated | App details, workspace, ratings, and comments. |
| `/admin` | Admin | Manage the app registry and feedback. |
| `/settings` | Authenticated | Session and account settings. |

## Project structure

```text
src/
├── components/
│   ├── layout/       Shared shell, navigation, and top bar
│   ├── marketplace/  Cards, filters, statistics, ratings, and comments
│   ├── workspace/    The individual app workspaces
│   └── admin/        App registry management
├── context/          Authentication and app registry state
├── integrations/     Supabase client and generated database types
├── lib/              API clients, orchestration, constants, and seed data
└── pages/            Login, marketplace, app detail, admin, and settings
supabase/
├── functions/        Edge Functions
└── migrations/       Database schema and policy migrations
```

`src/pages/AppDetail.tsx` is the central workspace dispatcher. It uses the app's `input_schema.appType` to render the appropriate workspace, so new app types should be integrated there rather than creating a separate routing system.

## Available scripts

```bash
npm run dev         # Start Vite in development mode
npm run build       # Create a production build
npm run build:dev   # Create a development-mode build
npm run preview     # Preview the production build locally
npm run lint        # Run ESLint
npm test            # Run the Vitest test suite
npm run test:watch  # Run Vitest in watch mode
```

## API and security notes

- Browser code calls ScalePad through the `scalepad-proxy` Supabase Edge Function.
- Raw ScalePad API keys are stored only in session storage for the active session; they are not written to the app registry or database.
- Feedback identifies non-admin users with a SHA-256 hash of the API key rather than storing the raw key.
- Admin routes are protected by the authenticated Supabase admin role.
- Destructive operations such as cleanup, reset, and migration should be reviewed carefully before execution because they operate on real Lifecycle Manager data.

## Testing and verification

Before opening a pull request, run:

```bash
npm run lint
npm test
npm run build
```

When adding or changing a marketplace app, verify its seed metadata, app-detail dispatch, API helper, loading/error states, and any destructive-operation confirmation flow.

## Contributing

Keep new apps consistent with the existing marketplace pattern:

1. Add the app metadata to `src/lib/mock-data.ts`.
2. Add or reuse an API helper in `src/lib` and route external requests through `scalepad-proxy`.
3. Add the workspace under `src/components/workspace` when the app needs custom behavior.
4. Register the workspace in `src/pages/AppDetail.tsx` using its `appType`.
5. Reuse the existing layout, pagination, toast, progress, and error-handling patterns.
6. Add tests for new orchestration and data-mapping behavior.

Avoid committing environment files, API keys, Supabase service-role credentials, generated build output, or customer data.
