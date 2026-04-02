import { describe, expect, it } from "vitest";

import { buildContractCreatePayload } from "./tenant-migration-api";

describe("buildContractCreatePayload", () => {
  it("preserves notify_days_before_end_date = 30 from source detail", () => {
    const payload = buildContractCreatePayload({
      title: "Microsoft 365 Business Premium",
      notify_days_before_end_date: 30,
    });

    expect(payload.notify_days_before_end_date).toBe(30);
  });

  it("preserves a non-default notify_days_before_end_date = 60", () => {
    const payload = buildContractCreatePayload({
      create_payload: {
        title: "Salesforce Sales Cloud",
        notify_days_before_end_date: 60,
      },
    });

    expect(payload.notify_days_before_end_date).toBe(60);
  });

  it("handles missing notify_days_before_end_date safely", () => {
    const payload = buildContractCreatePayload({
      title: "Contract Without Alert Lead Time",
    });

    expect(payload).not.toHaveProperty("notify_days_before_end_date");
  });

  it("prefers contract detail values over list values for alert lead time", () => {
    const payload = buildContractCreatePayload({
      title: "Detailed Contract",
      notify_days_before_end_date: 15,
      create_payload: {
        notify_days_before_end_date: 45,
      },
    });

    expect(payload.notify_days_before_end_date).toBe(45);
  });
});
