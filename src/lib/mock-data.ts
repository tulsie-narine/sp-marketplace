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
  {
    id: "app-011",
    name: "Client Clean Up",
    description:
      "Select clients and permanently delete their Lifecycle Manager data by object type — initiatives, goals, meetings, action items, notes, assessments, contracts, and deliverables.",
    how_it_works:
      "Fetches your client list, lets you select which clients and data types to clean, then sequentially deletes each record via the Lifecycle Manager API with real-time progress tracking and error logging.",
    category: "Utilities",
    icon: "🧹",
    status: "active",
    version: "1.0.0",
    author: "ScalePad Team",
    api_endpoint: "/lifecycle-manager/v1/*",
    input_schema: {
      realApi: true,
      appType: "client-cleanup",
      fields: [],
    },
    created_at: "2026-04-01T10:00:00Z",
  },
  {
    id: "app-012",
    name: "ControlMap to LMX Roadmap Builder",
    description:
      "Review ControlMap risks and action items, then promote selected priorities into Lifecycle Manager initiatives for QBR-ready strategic roadmaps.",
    how_it_works:
      "Fetches client health and risk summary data from the ControlMap API, displays a portfolio-level risk overview with drill-down into individual client risks, and provides a planning drawer to create action items or promote risks to Lifecycle Manager initiatives with full 6-step orchestration.",
    category: "Reporting",
    icon: "🎯",
    status: "active",
    version: "1.0.0",
    author: "ScalePad Team",
    api_endpoint: "/controlmap/v1/*",
    input_schema: {
      realApi: true,
      appType: "risk-roadmap",
      fields: [],
    },
    created_at: "2026-04-02T10:00:00Z",
  },
  {
    id: "app-013",
    name: "LCM Data Reset",
    description:
      "A dedicated clone of the Tenant Migration utility that will be adapted into a controlled Lifecycle Manager reset workflow.",
    how_it_works:
      "Starts from the same client-mapping and execution framework as Tenant Migration, but is registered as its own app so it can evolve independently into a reset-focused Lifecycle Manager utility.",
    category: "Utilities",
    icon: "🧰",
    status: "active",
    version: "1.0.0",
    author: "ScalePad Team",
    api_endpoint: "/lifecycle-manager/v1/*",
    input_schema: {
      realApi: true,
      appType: "lcm-data-reset",
      fields: [],
    },
    created_at: "2026-04-10T10:00:00Z",
  },
];
