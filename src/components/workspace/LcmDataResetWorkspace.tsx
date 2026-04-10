import { TenantMigrationWorkspace } from "@/components/workspace/TenantMigrationWorkspace";

const RESET_COPY = {
  title: "LCM Data Reset",
  subtitle:
    "A dedicated clone of Tenant Migration that we can now tailor into a controlled Lifecycle Manager reset workflow.",
  stepFourLabel: "Run",
  runButtonLabel: "Start Run",
  runningTitle: "LCM Data Reset in Progress - do not close this window",
  completeToastTitle: "LCM Data Reset complete",
  stoppedToastTitle: "LCM Data Reset stopped unexpectedly",
  completeHeading: "LCM Data Reset Complete",
  runAgainLabel: "Run Another Reset",
  errorCsvFilename: "lcm-data-reset-errors.csv",
  debugJsonFilename: "lcm-data-reset-debug-export.json",
  finalSummaryVerb: "processed",
} as const;

export function LcmDataResetWorkspace() {
  return <TenantMigrationWorkspace copy={RESET_COPY} />;
}
