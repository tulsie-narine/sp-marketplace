import { MarketplaceApp } from "./constants";

/** Seed data for the marketplace — mirrors the planned Supabase table */
export const SEED_APPS: MarketplaceApp[] = [
  {
    id: "app-007",
    name: "List Opportunities",
    description:
      "View all sales opportunities across your clients with their current stage — pulled live from the ScalePad API.",
    how_it_works:
      "Calls the ScalePad List Opportunities endpoint (GET /core/v1/opportunities) using your API key, and displays a table of client names, opportunity titles, and sale stages.",
    category: "Reporting",
    icon: "💰",
    status: "active",
    version: "1.0.0",
    author: "ScalePad Team",
    api_endpoint: "/core/v1/opportunities",
    input_schema: {
      realApi: true,
      fields: [],
    },
    created_at: "2025-03-10T10:00:00Z",
  },
  {
    id: "app-008",
    name: "Initiative Manager",
    description:
      "View existing ScalePad Initiatives, configure a template with all attributes, then deploy it across multiple clients simultaneously.",
    how_it_works:
      "Fetches your initiatives and client list from the Lifecycle Manager API, lets you build or clone an initiative template (status, priority, schedule, budgets), select target clients, and deploys the initiative to each client in sequence with real-time progress tracking.",
    category: "Planning",
    icon: "🚀",
    status: "active",
    version: "1.0.0",
    author: "ScalePad Team",
    api_endpoint: "/lifecycle-manager/v1/initiatives",
    input_schema: {
      realApi: true,
      appType: "initiative-manager",
      fields: [],
    },
    created_at: "2025-03-12T10:00:00Z",
  },
  {
    id: "app-009",
    name: "Goal Manager",
    description:
      "View, edit, and deploy goals across multiple clients using the ScalePad Lifecycle Manager API.",
    how_it_works:
      "Fetches your goals and client list from the Lifecycle Manager API, lets you build or clone a goal template (title, description, status, period), select target clients, and deploys the goal to each client in sequence with real-time progress tracking.",
    category: "Planning",
    icon: "🎯",
    status: "active",
    version: "1.0.0",
    author: "ScalePad Team",
    api_endpoint: "/lifecycle-manager/v1/goals",
    input_schema: {
      realApi: true,
      appType: "goal-manager",
      fields: [],
    },
    created_at: "2025-03-15T10:00:00Z",
  },
  {
    id: "app-010",
    name: "Tenant Migration",
    description:
      "Migrate client data between two ScalePad tenants - map clients, select objects, and run a tracked migration with a full error log.",
    how_it_works:
      "Connects to a source tenant API key at launch, auto-matches source clients to destination clients, lets you choose which Lifecycle Manager objects to migrate, and then runs each client migration sequentially with live progress, retry handling, and final summary/error logs.",
    category: "Utilities",
    icon: "🔄",
    status: "active",
    version: "1.0.0",
    author: "ScalePad Team",
    api_endpoint: "/lifecycle-manager/v1/*",
    input_schema: {
      realApi: true,
      appType: "tenant-migration",
      fields: [],
    },
    created_at: "2026-03-28T10:00:00Z",
  },
];
