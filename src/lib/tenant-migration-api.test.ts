import { describe, expect, it } from "vitest";

import {
  buildAssessmentTemplateCreatePayload,
  buildContractCreatePayload,
  buildTagCreatePayload,
  buildUserResolutionMap,
} from "./tenant-migration-api";

describe("buildTagCreatePayload", () => {
  it("wraps the tag and excludes tenant-scoped identifiers", () => {
    const payload = buildTagCreatePayload({
      tag_id: "source-tag",
      name: "Security",
      domain: "client",
      color: "blue",
    });

    expect(payload).toEqual({
      tag: { name: "Security", domain: "client", color: "blue" },
    });
    expect(payload.tag).not.toHaveProperty("tag_id");
  });
});

describe("buildAssessmentTemplateCreatePayload", () => {
  it("removes tenant-scoped IDs and preserves the template structure", () => {
    const payload = buildAssessmentTemplateCreatePayload({
      assessment_template_id: "source-template",
      title: "Security Review",
      description: "Source description",
      categories: [
        {
          assessment_template_category_id: "source-category",
          title: "Access",
          questions: [
            {
              assessment_template_question_id: "source-question",
              title: "Is MFA enabled?",
              tag_ids: ["source-tag"],
              criteria: [
                {
                  assessment_template_criterion_id: "source-criterion",
                  label_enum: "YES",
                  description: "Enabled",
                },
              ],
            },
          ],
        },
      ],
    });

    expect(payload.assessment_template).not.toHaveProperty(
      "assessment_template_id"
    );
    expect(payload.assessment_template.categories[0]).not.toHaveProperty(
      "assessment_template_category_id"
    );
    expect(
      payload.assessment_template.categories[0].questions[0]
    ).not.toHaveProperty("assessment_template_question_id");
    expect(
      payload.assessment_template.categories[0].questions[0].criteria[0]
    ).not.toHaveProperty("assessment_template_criterion_id");
    expect(
      payload.assessment_template.categories[0].questions[0].tag_ids
    ).toEqual([]);
  });
});

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

describe("buildUserResolutionMap", () => {
  it("maps every source id and email of a matched person to the destination user", () => {
    const map = buildUserResolutionMap([
      { key: "ana@msp.com", sourceName: "Ana", sourceEmail: "ana@msp.com", sourceUserIds: ["src-user", "src-member"], destinationUserId: "dst-ana", matchedBy: "email" },
      { key: "id:src-bob", sourceName: "Bob", sourceEmail: null, sourceUserIds: ["src-bob"], destinationUserId: null, matchedBy: "none" },
    ]);

    expect(map.byId).toEqual({ "src-user": "dst-ana", "src-member": "dst-ana" });
    expect(map.byEmail).toEqual({ "ana@msp.com": "dst-ana" });
  });
});

describe("buildAssessmentTemplateCreatePayload with blank text", () => {
  it("never sends an empty description, which the API rejects with 422", () => {
    const payload = buildAssessmentTemplateCreatePayload({
      title: "Security Review",
      description: "",
      categories: [{ title: "Identity", description: "", questions: [{ title: "MFA enforced?", description: " ", criteria: [{ label_enum: "AtRisk", description: "" }, { label_enum: "Satisfactory" }] }] }],
    });
    const template = payload.assessment_template;
    const question = template.categories[0].questions[0];

    expect(template.description).toBe("Security Review");
    expect(template.categories[0]).not.toHaveProperty("description");
    expect(question.description).toBe("MFA enforced?");
    expect(question.criteria.map((c) => c.description)).toEqual(["At risk", "Satisfactory"]);
  });
});
