// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, it, expect } from "vitest";
import {
  // common
  ErrorResponseSchema,
  PaginationQuerySchema,
  SoftDeleteFieldsSchema,
  // scenario
  PersonalitySchema,
  ExperienceSchema,
  VerbositySchema,
  UserTypeSchema,
  PersonaSchema,
  ScenarioSchema,
  // request
  CreateRequestInputSchema,
  RequestResponseSchema,
  RequestStatusSchema,
  RequestOutcomeSchema,
  WorkerTypeSchema,
  LogEventSchema,
  TokenUsageSchema,
  ConversationTurnSchema,
  CriterionResultSchema,
  ListRequestsQuerySchema,
  BulkResubmitInputSchema,
  // criteria
  CreateCriteriaInputSchema,
  CriteriaResponseSchema,
  UpdateCriteriaInputSchema,
  CriteriaGraphSchema,
  // prompt-feature
  CreatePromptFeatureInputSchema,
  PromptFeatureResponseSchema,
  PromptFeatureResultSchema,
  // report
  ReportResponseSchema,
  ReportStatusSchema,
  ReporterSchema,
  CreateReportInputSchema,
  InsightReferenceSchema,
  // report-template
  ReportTriggerSchema,
  CreateReportTemplateInputSchema,
  ReportTemplateResponseSchema,
  ReportTemplateSystemPromptSchema,
  // insight
  CreateInsightInputSchema,
  InsightResponseSchema,
  // agent
  CreateAgentInputSchema,
  AgentResponseSchema,
  AgentVersionSchema,
  RegisterAgentVersionInputSchema,
  PatchAgentVersionInputSchema,
  // model
  ModelResponseSchema,
  ModelSyncInputSchema,
  ListModelsQuerySchema,
  // mcp-server
  McpTransportTypeSchema,
  CreateMcpServerInputSchema,
  McpServerResponseSchema,
  // skill
  SkillOriginSchema,
  CreateSkillInputSchema,
  SkillResponseSchema,
  // extension
  ExtensionOriginSchema,
  CreateExtensionInputSchema,
  ExtensionResponseSchema,
  ExtensionSearchResultSchema,
  // feature-flag
  FeatureFlagResponseSchema,
  UpdateFeatureFlagInputSchema,
} from "./index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const NOW = new Date().toISOString();

// ---------------------------------------------------------------------------
// common.ts
// ---------------------------------------------------------------------------
describe("common schemas", () => {
  describe("ErrorResponseSchema", () => {
    it("accepts a valid error response", () => {
      expect(ErrorResponseSchema.parse({ error: "something went wrong" })).toEqual({
        error: "something went wrong",
      });
    });

    it("rejects missing error field", () => {
      expect(() => ErrorResponseSchema.parse({})).toThrow();
    });

    it("rejects non-string error", () => {
      expect(() => ErrorResponseSchema.parse({ error: 42 })).toThrow();
    });
  });

  describe("PaginationQuerySchema", () => {
    it("accepts valid pagination", () => {
      const result = PaginationQuerySchema.parse({ page: 1, limit: 50 });
      expect(result.page).toBe(1);
      expect(result.limit).toBe(50);
    });

    it("allows omitting all fields", () => {
      const result = PaginationQuerySchema.parse({});
      expect(result.page).toBeUndefined();
      expect(result.limit).toBeUndefined();
    });

    it("rejects page < 1", () => {
      expect(() => PaginationQuerySchema.parse({ page: 0 })).toThrow();
    });

    it("rejects limit > 100", () => {
      expect(() => PaginationQuerySchema.parse({ limit: 200 })).toThrow();
    });
  });

  describe("SoftDeleteFieldsSchema", () => {
    it("accepts required + optional fields", () => {
      const result = SoftDeleteFieldsSchema.parse({ createdAt: NOW });
      expect(result.createdAt).toBeInstanceOf(Date);
      expect(result.updatedAt).toBeUndefined();
    });
  });
});

// ---------------------------------------------------------------------------
// scenario.ts
// ---------------------------------------------------------------------------
describe("scenario schemas", () => {
  describe("enum schemas", () => {
    it.each([
      ["PersonalitySchema", PersonalitySchema, "demanding", "angry"],
      ["ExperienceSchema", ExperienceSchema, "junior", "mid"],
      ["VerbositySchema", VerbositySchema, "brief", "verbose"],
      ["UserTypeSchema", UserTypeSchema, "vibe", "hybrid"],
    ] as const)("%s accepts valid and rejects invalid", (_name, schema, valid, invalid) => {
      expect(schema.parse(valid)).toBe(valid);
      expect(() => schema.parse(invalid)).toThrow();
    });
  });

  describe("PersonaSchema", () => {
    const validPersona = {
      personality: "friendly",
      experience: "senior",
      verbosity: "moderate",
      type: "ai_assisted",
    };

    it("accepts a valid persona", () => {
      expect(PersonaSchema.parse(validPersona)).toMatchObject(validPersona);
    });

    it("rejects missing personality", () => {
      const { personality: _, ...rest } = validPersona;
      expect(() => PersonaSchema.parse(rest)).toThrow();
    });
  });

  describe("ScenarioSchema", () => {
    const validScenario = { task: "Build a TODO app", criteria: ["works", "tests_pass"] };

    it("accepts a valid scenario", () => {
      expect(ScenarioSchema.parse(validScenario)).toMatchObject(validScenario);
    });

    it("accepts optional version field", () => {
      const result = ScenarioSchema.parse({ ...validScenario, version: "v2" });
      expect(result.version).toBe("v2");
    });

    it("rejects invalid version enum", () => {
      expect(() => ScenarioSchema.parse({ ...validScenario, version: "v3" })).toThrow();
    });

    it("rejects missing task", () => {
      expect(() => ScenarioSchema.parse({ criteria: ["a"] })).toThrow();
    });

    it("rejects missing criteria", () => {
      expect(() => ScenarioSchema.parse({ task: "do something" })).toThrow();
    });
  });
});

// ---------------------------------------------------------------------------
// request.ts
// ---------------------------------------------------------------------------
describe("request schemas", () => {
  const validScenario = { task: "Build it", criteria: ["c1"] };

  describe("RequestStatusSchema", () => {
    it.each(["pending", "processing", "done"])(
      "accepts '%s'",
      (status) => {
        expect(RequestStatusSchema.parse(status)).toBe(status);
      },
    );

    it("rejects old status values", () => {
      expect(() => RequestStatusSchema.parse("completed")).toThrow();
      expect(() => RequestStatusSchema.parse("iterating")).toThrow();
      expect(() => RequestStatusSchema.parse("finished")).toThrow();
      expect(() => RequestStatusSchema.parse("failed")).toThrow();
    });

    it("rejects unknown status", () => {
      expect(() => RequestStatusSchema.parse("cancelled")).toThrow();
    });
  });

  describe("RequestOutcomeSchema", () => {
    it.each(["succeeded", "failed", "finished"])(
      "accepts '%s'",
      (outcome) => {
        expect(RequestOutcomeSchema.parse(outcome)).toBe(outcome);
      },
    );

    it("rejects unknown outcome", () => {
      expect(() => RequestOutcomeSchema.parse("completed")).toThrow();
      expect(() => RequestOutcomeSchema.parse("cancelled")).toThrow();
    });
  });

  describe("WorkerTypeSchema", () => {
    it.each(["coder-acp-claude-code", "coder-acp-copilot", "coder-vscode-web"])(
      "accepts '%s'",
      (w) => {
        expect(WorkerTypeSchema.parse(w)).toBe(w);
      },
    );

    it("rejects unknown worker", () => {
      expect(() => WorkerTypeSchema.parse("unknown-worker")).toThrow();
    });
  });

  describe("CreateRequestInputSchema", () => {
    it("accepts minimal valid input", () => {
      const result = CreateRequestInputSchema.parse({ scenario: validScenario });
      expect(result.scenario.task).toBe("Build it");
    });

    it("accepts all optional fields", () => {
      const input = {
        scenario: validScenario,
        model: "gpt-4",
        maxIterations: 5,
        personaInstructions: "be nice",
        persona: { personality: "friendly", experience: "senior", verbosity: "brief", type: "traditional" },
        mcpServers: ["srv1"],
        skillRevisions: ["rev1"],
      };
      const result = CreateRequestInputSchema.parse(input);
      expect(result.model).toBe("gpt-4");
      expect(result.maxIterations).toBe(5);
    });

    it("rejects missing scenario", () => {
      expect(() => CreateRequestInputSchema.parse({})).toThrow();
    });

    it("rejects invalid scenario (missing task)", () => {
      expect(() =>
        CreateRequestInputSchema.parse({ scenario: { criteria: ["c"] } }),
      ).toThrow();
    });
  });

  describe("RequestResponseSchema", () => {
    const minimal = {
      _id: "abc123",
      scenario: validScenario,
      workerType: "coder-acp-copilot",
      createdAt: NOW,
    };

    it("accepts a minimal valid response", () => {
      const result = RequestResponseSchema.parse(minimal);
      expect(result._id).toBe("abc123");
      expect(result.createdAt).toBeInstanceOf(Date);
    });

    it("optional fields can be omitted", () => {
      const result = RequestResponseSchema.parse(minimal);
      expect(result.model).toBeUndefined();
      expect(result.run).toBeUndefined();
    });

    it("rejects missing _id", () => {
      const { _id: _, ...rest } = minimal;
      expect(() => RequestResponseSchema.parse(rest)).toThrow();
    });

    it("rejects invalid run status", () => {
      expect(() =>
        RequestResponseSchema.parse({
          ...minimal,
          run: { status: "unknown" },
        }),
      ).toThrow();
    });
  });

  describe("TokenUsageSchema", () => {
    it("accepts valid token usage", () => {
      const result = TokenUsageSchema.parse({
        promptTokens: 100,
        completionTokens: 50,
        totalTokens: 150,
      });
      expect(result.totalTokens).toBe(150);
    });

    it("rejects missing field", () => {
      expect(() => TokenUsageSchema.parse({ promptTokens: 1 })).toThrow();
    });
  });

  describe("LogEventSchema", () => {
    it("accepts valid log event", () => {
      const result = LogEventSchema.parse({
        timestamp: NOW,
        level: "info",
        message: "hello",
      });
      expect(result.level).toBe("info");
    });

    it("rejects invalid level", () => {
      expect(() =>
        LogEventSchema.parse({ timestamp: NOW, level: "trace", message: "x" }),
      ).toThrow();
    });
  });

  describe("CriterionResultSchema", () => {
    it("accepts valid criterion result", () => {
      const result = CriterionResultSchema.parse({
        criterionId: "c1",
        passed: true,
        feedback: "looks good",
        evaluated: true,
      });
      expect(result.passed).toBe(true);
    });
  });

  describe("ConversationTurnSchema", () => {
    it("accepts a valid turn", () => {
      const result = ConversationTurnSchema.parse({
        iteration: 1,
        codingAgentResponse: "done",
        judgeFeedback: "pass",
        snapshotUrl: "https://example.com/snap",
        passed: true,
        timestamp: NOW,
      });
      expect(result.iteration).toBe(1);
    });
  });

  describe("ListRequestsQuerySchema", () => {
    it("accepts empty query (all optional)", () => {
      expect(ListRequestsQuerySchema.parse({})).toBeDefined();
    });

    it("accepts status filter", () => {
      const result = ListRequestsQuerySchema.parse({ status: "done" });
      expect(result.status).toBe("done");
    });

    it("accepts last-page query flag", () => {
      const result = ListRequestsQuerySchema.parse({ last: "true" });
      expect(result.last).toBe("true");
    });

    it("accepts iteration-count filters with operators", () => {
      const result = ListRequestsQuerySchema.parse({
        turns: "5",
        turnsOp: "gte",
        maxIterations: "10",
        maxIterationsOp: "lte",
      });
      expect(result.turns).toBe(5);
      expect(result.turnsOp).toBe("gte");
      expect(result.maxIterations).toBe(10);
      expect(result.maxIterationsOp).toBe("lte");
    });

    it("rejects invalid operator", () => {
      expect(() =>
        ListRequestsQuerySchema.parse({ turns: "1", turnsOp: "ne" }),
      ).toThrow();
    });

    it("rejects negative turns", () => {
      expect(() => ListRequestsQuerySchema.parse({ turns: "-1" })).toThrow();
    });
  });

  describe("BulkResubmitInputSchema", () => {
    it("accepts valid input with ids", () => {
      const result = BulkResubmitInputSchema.parse({ ids: ["r1", "r2"] });
      expect(result.ids).toHaveLength(2);
      expect(result.count).toBe(1); // default
    });

    it("accepts input with count and overrides", () => {
      const result = BulkResubmitInputSchema.parse({
        ids: ["r1"],
        count: 3,
        overrides: { workerType: "coder-acp-copilot", model: "gpt-4o" },
      });
      expect(result.count).toBe(3);
      expect(result.overrides?.workerType).toBe("coder-acp-copilot");
    });

    it("rejects missing ids", () => {
      expect(() => BulkResubmitInputSchema.parse({})).toThrow();
    });

    it("rejects empty ids array", () => {
      expect(() => BulkResubmitInputSchema.parse({ ids: [] })).toThrow();
    });

    it("rejects count outside range", () => {
      expect(() => BulkResubmitInputSchema.parse({ ids: ["r1"], count: 0 })).toThrow();
      expect(() => BulkResubmitInputSchema.parse({ ids: ["r1"], count: 11 })).toThrow();
    });
  });
});

// ---------------------------------------------------------------------------
// criteria.ts
// ---------------------------------------------------------------------------
describe("criteria schemas", () => {
  describe("CreateCriteriaInputSchema", () => {
    it("accepts a valid lowercase id", () => {
      const result = CreateCriteriaInputSchema.parse({
        id: "valid_id",
        prompt: "Check something",
      });
      expect(result.id).toBe("valid_id");
    });

    it("accepts id starting with letter followed by digits", () => {
      expect(
        CreateCriteriaInputSchema.parse({ id: "a1b2", prompt: "ok" }),
      ).toBeDefined();
    });

    it("allows omitting dependsOn", () => {
      const result = CreateCriteriaInputSchema.parse({ id: "abc", prompt: "p" });
      expect(result.dependsOn).toBeUndefined();
    });

    it("rejects id starting with uppercase (Invalid-Id)", () => {
      expect(() =>
        CreateCriteriaInputSchema.parse({ id: "Invalid-Id", prompt: "p" }),
      ).toThrow();
    });

    it("rejects id starting with a digit (123abc)", () => {
      expect(() =>
        CreateCriteriaInputSchema.parse({ id: "123abc", prompt: "p" }),
      ).toThrow();
    });

    it("rejects id with hyphens", () => {
      expect(() =>
        CreateCriteriaInputSchema.parse({ id: "my-criterion", prompt: "p" }),
      ).toThrow();
    });

    it("rejects id with spaces", () => {
      expect(() =>
        CreateCriteriaInputSchema.parse({ id: "has space", prompt: "p" }),
      ).toThrow();
    });

    it("rejects empty id", () => {
      expect(() =>
        CreateCriteriaInputSchema.parse({ id: "", prompt: "p" }),
      ).toThrow();
    });

    it("rejects missing prompt", () => {
      expect(() => CreateCriteriaInputSchema.parse({ id: "abc" })).toThrow();
    });
  });

  describe("CriteriaResponseSchema", () => {
    it("accepts a valid response", () => {
      const result = CriteriaResponseSchema.parse({
        id: "my_criterion",
        prompt: "Does it work?",
        createdAt: NOW,
      });
      expect(result.id).toBe("my_criterion");
      expect(result.createdAt).toBeInstanceOf(Date);
    });

    it("optional fields can be omitted", () => {
      const result = CriteriaResponseSchema.parse({
        id: "x",
        prompt: "p",
        createdAt: NOW,
      });
      expect(result.dependsOn).toBeUndefined();
      expect(result.updatedAt).toBeUndefined();
      expect(result.deletedAt).toBeUndefined();
    });
  });

  describe("UpdateCriteriaInputSchema", () => {
    it("accepts empty object (all optional)", () => {
      expect(UpdateCriteriaInputSchema.parse({})).toBeDefined();
    });
  });

  describe("CriteriaGraphSchema", () => {
    it("accepts valid graph", () => {
      const result = CriteriaGraphSchema.parse({
        nodes: [{ id: "a", prompt: "A" }],
        edges: [{ from: "a", to: "b" }],
      });
      expect(result.nodes).toHaveLength(1);
      expect(result.edges).toHaveLength(1);
    });

    it("rejects missing nodes", () => {
      expect(() => CriteriaGraphSchema.parse({ edges: [] })).toThrow();
    });
  });
});

// ---------------------------------------------------------------------------
// prompt-feature.ts
// ---------------------------------------------------------------------------
describe("prompt-feature schemas", () => {
  describe("CreatePromptFeatureInputSchema", () => {
    it("accepts valid lowercase id", () => {
      const result = CreatePromptFeatureInputSchema.parse({
        id: "my_feature",
        prompt: "Check feature",
      });
      expect(result.id).toBe("my_feature");
    });

    it("rejects id with uppercase", () => {
      expect(() =>
        CreatePromptFeatureInputSchema.parse({ id: "BadId", prompt: "p" }),
      ).toThrow();
    });

    it("rejects id starting with digit", () => {
      expect(() =>
        CreatePromptFeatureInputSchema.parse({ id: "1feature", prompt: "p" }),
      ).toThrow();
    });
  });

  describe("PromptFeatureResponseSchema", () => {
    it("accepts valid response", () => {
      const result = PromptFeatureResponseSchema.parse({
        id: "feat1",
        prompt: "p",
        createdAt: NOW,
      });
      expect(result.id).toBe("feat1");
    });
  });

  describe("PromptFeatureResultSchema", () => {
    it("accepts valid result", () => {
      const result = PromptFeatureResultSchema.parse({
        featureId: "f1",
        detected: true,
        evaluated: false,
      });
      expect(result.detected).toBe(true);
    });

    it("rejects missing evaluated", () => {
      expect(() =>
        PromptFeatureResultSchema.parse({ featureId: "f1", detected: true }),
      ).toThrow();
    });
  });
});

// ---------------------------------------------------------------------------
// report.ts
// ---------------------------------------------------------------------------
describe("report schemas", () => {
  describe("ReportStatusSchema", () => {
    it.each(["pending", "generating", "completed", "failed"])(
      "accepts '%s'",
      (s) => {
        expect(ReportStatusSchema.parse(s)).toBe(s);
      },
    );

    it("rejects unknown status", () => {
      expect(() => ReportStatusSchema.parse("running")).toThrow();
    });
  });

  describe("ReporterSchema", () => {
    it("accepts valid reporter", () => {
      const result = ReporterSchema.parse({
        id: "r1",
        name: "Judge",
        gitHash: "abc123",
        model: "gpt-4",
        agentId: "a1",
        agentVersion: "1.0.0",
      });
      expect(result.name).toBe("Judge");
    });

    it("rejects missing name", () => {
      expect(() =>
        ReporterSchema.parse({
          id: "r1",
          gitHash: "abc",
          model: "m",
          agentId: "a",
          agentVersion: "v",
        }),
      ).toThrow();
    });
  });

  describe("ReportResponseSchema", () => {
    const minimal = {
      _id: "rep1",
      requestId: "req1",
      status: "pending",
      createdAt: NOW,
    };

    it("accepts minimal valid response", () => {
      const result = ReportResponseSchema.parse(minimal);
      expect(result._id).toBe("rep1");
    });

    it("optional fields can be omitted", () => {
      const result = ReportResponseSchema.parse(minimal);
      expect(result.templateId).toBeUndefined();
      expect(result.reporter).toBeUndefined();
      expect(result.content).toBeUndefined();
      expect(result.insightReferences).toBeUndefined();
    });

    it("rejects missing requestId", () => {
      const { requestId: _, ...rest } = minimal;
      expect(() => ReportResponseSchema.parse(rest)).toThrow();
    });
  });

  describe("CreateReportInputSchema", () => {
    it("accepts valid input", () => {
      expect(CreateReportInputSchema.parse({ requestId: "r1" })).toBeDefined();
    });

    it("accepts optional templateId", () => {
      const result = CreateReportInputSchema.parse({
        requestId: "r1",
        templateId: "t1",
      });
      expect(result.templateId).toBe("t1");
    });

    it("rejects missing requestId", () => {
      expect(() => CreateReportInputSchema.parse({})).toThrow();
    });
  });

  describe("InsightReferenceSchema", () => {
    it("accepts valid reference", () => {
      const result = InsightReferenceSchema.parse({
        insightId: "i1",
        referencedAt: NOW,
        isNew: true,
      });
      expect(result.isNew).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// report-template.ts
// ---------------------------------------------------------------------------
describe("report-template schemas", () => {
  describe("ReportTriggerSchema (discriminated union)", () => {
    it("accepts 'always' trigger", () => {
      const result = ReportTriggerSchema.parse({ type: "always" });
      expect(result.type).toBe("always");
    });

    it("accepts 'criteria' trigger", () => {
      const result = ReportTriggerSchema.parse({
        type: "criteria",
        criteriaIds: ["c1", "c2"],
        match: "any",
      });
      expect(result.type).toBe("criteria");
    });

    it("accepts 'criteria' trigger without optional match", () => {
      const result = ReportTriggerSchema.parse({
        type: "criteria",
        criteriaIds: ["c1"],
      });
      expect(result).toBeDefined();
    });

    it("accepts 'taskPrompt' trigger", () => {
      const result = ReportTriggerSchema.parse({
        type: "taskPrompt",
        taskPromptIds: ["tp1"],
      });
      expect(result.type).toBe("taskPrompt");
    });

    it("accepts 'promptFeature' trigger", () => {
      const result = ReportTriggerSchema.parse({
        type: "promptFeature",
        featureIds: ["f1"],
        match: "all",
      });
      expect(result.type).toBe("promptFeature");
    });

    it("rejects unknown trigger type", () => {
      expect(() =>
        ReportTriggerSchema.parse({ type: "schedule" }),
      ).toThrow();
    });

    it("rejects criteria trigger missing criteriaIds", () => {
      expect(() =>
        ReportTriggerSchema.parse({ type: "criteria" }),
      ).toThrow();
    });

    it("rejects invalid match value", () => {
      expect(() =>
        ReportTriggerSchema.parse({
          type: "criteria",
          criteriaIds: ["c1"],
          match: "some",
        }),
      ).toThrow();
    });
  });

  describe("ReportTemplateSystemPromptSchema", () => {
    it("accepts valid system prompt", () => {
      const result = ReportTemplateSystemPromptSchema.parse({
        mode: "append",
        content: "Additional instructions",
      });
      expect(result.mode).toBe("append");
    });

    it("rejects invalid mode", () => {
      expect(() =>
        ReportTemplateSystemPromptSchema.parse({ mode: "replace", content: "x" }),
      ).toThrow();
    });
  });

  describe("CreateReportTemplateInputSchema", () => {
    const valid = { id: "tmpl1", name: "My Template", userPrompt: "Analyze this" };

    it("accepts valid input", () => {
      expect(CreateReportTemplateInputSchema.parse(valid)).toBeDefined();
    });

    it("accepts with trigger", () => {
      const result = CreateReportTemplateInputSchema.parse({
        ...valid,
        trigger: { type: "always" },
      });
      expect(result.trigger).toEqual({ type: "always" });
    });

    it("rejects missing userPrompt", () => {
      expect(() =>
        CreateReportTemplateInputSchema.parse({ id: "t", name: "n" }),
      ).toThrow();
    });
  });

  describe("ReportTemplateResponseSchema", () => {
    it("accepts valid response", () => {
      const result = ReportTemplateResponseSchema.parse({
        _id: "mongo1",
        id: "tmpl1",
        name: "Template",
        userPrompt: "Analyze",
        createdAt: NOW,
      });
      expect(result._id).toBe("mongo1");
    });
  });
});

// ---------------------------------------------------------------------------
// insight.ts
// ---------------------------------------------------------------------------
describe("insight schemas", () => {
  describe("CreateInsightInputSchema", () => {
    it("accepts valid input", () => {
      const result = CreateInsightInputSchema.parse({
        title: "Performance Issue",
        description: "Slow response",
      });
      expect(result.title).toBe("Performance Issue");
    });

    it("accepts optional fields", () => {
      const result = CreateInsightInputSchema.parse({
        title: "t",
        description: "d",
        category: "perf",
        tags: ["slow"],
        createdBy: "agent",
        sourceReportId: "r1",
      });
      expect(result.category).toBe("perf");
      expect(result.createdBy).toBe("agent");
    });

    it("rejects invalid createdBy value", () => {
      expect(() =>
        CreateInsightInputSchema.parse({
          title: "t",
          description: "d",
          createdBy: "system",
        }),
      ).toThrow();
    });
  });

  describe("InsightResponseSchema", () => {
    it("accepts valid response", () => {
      const result = InsightResponseSchema.parse({
        _id: "i1",
        title: "Insight",
        description: "desc",
        upvotes: 5,
        downvotes: 1,
        blocked: false,
        referenceCount: 3,
        createdBy: "user",
        createdAt: NOW,
      });
      expect(result.upvotes).toBe(5);
    });

    it("rejects missing upvotes", () => {
      expect(() =>
        InsightResponseSchema.parse({
          _id: "i1",
          title: "t",
          description: "d",
          downvotes: 0,
          blocked: false,
          referenceCount: 0,
          createdBy: "user",
          createdAt: NOW,
        }),
      ).toThrow();
    });
  });
});

// ---------------------------------------------------------------------------
// agent.ts
// ---------------------------------------------------------------------------
describe("agent schemas", () => {
  describe("CreateAgentInputSchema", () => {
    it("accepts valid input", () => {
      const result = CreateAgentInputSchema.parse({
        _id: "agent1",
        name: "Claude Code",
        supportedModels: ["claude-3"],
      });
      expect(result._id).toBe("agent1");
    });

    it("accepts missing supportedModels (optional — registration jobs omit it)", () => {
      const result = CreateAgentInputSchema.parse({ _id: "a", name: "n" });
      expect(result._id).toBe("a");
      expect(result.supportedModels).toBeUndefined();
    });
  });

  describe("AgentResponseSchema", () => {
    it("accepts valid response", () => {
      const result = AgentResponseSchema.parse({
        _id: "a1",
        name: "Agent",
        supportedModels: ["m1"],
        createdAt: NOW,
      });
      expect(result.name).toBe("Agent");
    });
  });

  describe("AgentVersionSchema", () => {
    it("accepts valid version", () => {
      const result = AgentVersionSchema.parse({
        agentVersion: "1.0.0",
        workerVersion: "2.0.0",
        components: { core: "1.0" },
        gitCommit: "abc123",
        buildTime: NOW,
        imageTag: "v1",
        queueName: "q1",
        status: "active",
        createdAt: NOW,
      });
      expect(result.status).toBe("active");
    });

    it("rejects invalid status", () => {
      expect(() =>
        AgentVersionSchema.parse({
          agentVersion: "1",
          workerVersion: "1",
          components: {},
          gitCommit: "x",
          buildTime: "x",
          imageTag: "x",
          queueName: "q",
          status: "deprecated",
          createdAt: NOW,
        }),
      ).toThrow();
    });
  });

  describe("PatchAgentVersionInputSchema", () => {
    it("accepts 'active'", () => {
      expect(PatchAgentVersionInputSchema.parse({ status: "active" }).status).toBe("active");
    });

    it("accepts 'retired'", () => {
      expect(PatchAgentVersionInputSchema.parse({ status: "retired" }).status).toBe("retired");
    });

    it("rejects 'deprecated'", () => {
      expect(() => PatchAgentVersionInputSchema.parse({ status: "deprecated" })).toThrow();
    });
  });
});

// ---------------------------------------------------------------------------
// model.ts
// ---------------------------------------------------------------------------
describe("model schemas", () => {
  describe("ModelResponseSchema", () => {
    it("accepts valid response", () => {
      const result = ModelResponseSchema.parse({
        _id: "m1",
        modelId: "gpt-4",
        provider: "openai",
        agentId: "a1",
        firstSeenAt: NOW,
        lastSeenAt: NOW,
      });
      expect(result.modelId).toBe("gpt-4");
    });

    it("optional dates can be omitted", () => {
      const result = ModelResponseSchema.parse({
        _id: "m1",
        modelId: "m",
        provider: "p",
        agentId: "a",
        firstSeenAt: NOW,
        lastSeenAt: NOW,
      });
      expect(result.disappearedAt).toBeUndefined();
    });
  });

  describe("ModelSyncInputSchema", () => {
    it("accepts valid sync input", () => {
      const result = ModelSyncInputSchema.parse({
        models: [{ modelId: "m", provider: "p", agentId: "a" }],
      });
      expect(result.models).toHaveLength(1);
    });
  });

  describe("ListModelsQuerySchema", () => {
    it("accepts empty query", () => {
      expect(ListModelsQuerySchema.parse({})).toBeDefined();
    });
  });
});

// ---------------------------------------------------------------------------
// mcp-server.ts
// ---------------------------------------------------------------------------
describe("mcp-server schemas", () => {
  describe("McpTransportTypeSchema", () => {
    it("accepts 'sse'", () => {
      expect(McpTransportTypeSchema.parse("sse")).toBe("sse");
    });

    it("accepts 'http'", () => {
      expect(McpTransportTypeSchema.parse("http")).toBe("http");
    });

    it("rejects 'websocket'", () => {
      expect(() => McpTransportTypeSchema.parse("websocket")).toThrow();
    });
  });

  describe("CreateMcpServerInputSchema", () => {
    it("accepts valid http input", () => {
      const result = CreateMcpServerInputSchema.parse({
        name: "My Server",
        type: "sse",
        url: "https://mcp.example.com",
      });
      expect(result.name).toBe("My Server");
    });

    it("accepts valid stdio input", () => {
      const result = CreateMcpServerInputSchema.parse({
        name: "filesystem",
        type: "stdio",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-filesystem", "/workspace"],
      });
      expect(result.name).toBe("filesystem");
      expect(result.type).toBe("stdio");
    });

    it("rejects unknown type", () => {
      expect(() =>
        CreateMcpServerInputSchema.parse({ name: "s", type: "websocket", url: "https://x.com" }),
      ).toThrow();
    });
  });

  describe("McpServerResponseSchema", () => {
    it("accepts valid response", () => {
      const result = McpServerResponseSchema.parse({
        _id: "ms1",
        name: "Server",
        type: "http",
        url: "https://example.com",
        createdAt: NOW,
      });
      expect(result.type).toBe("http");
    });
  });
});

// ---------------------------------------------------------------------------
// skill.ts
// ---------------------------------------------------------------------------
describe("skill schemas", () => {
  describe("SkillOriginSchema", () => {
    it("accepts 'skills-sh'", () => {
      expect(SkillOriginSchema.parse("skills-sh")).toBe("skills-sh");
    });

    it("accepts 'manual'", () => {
      expect(SkillOriginSchema.parse("manual")).toBe("manual");
    });

    it("rejects 'auto'", () => {
      expect(() => SkillOriginSchema.parse("auto")).toThrow();
    });
  });

  describe("CreateSkillInputSchema", () => {
    it("accepts valid input", () => {
      const result = CreateSkillInputSchema.parse({
        source: "github",
        skillName: "test-skill",
        name: "Test Skill",
        origin: "manual",
      });
      expect(result.skillName).toBe("test-skill");
    });

    it("rejects missing origin", () => {
      expect(() =>
        CreateSkillInputSchema.parse({ source: "s", skillName: "sk", name: "n" }),
      ).toThrow();
    });
  });

  describe("SkillResponseSchema", () => {
    it("accepts valid response", () => {
      const result = SkillResponseSchema.parse({
        _id: "s1",
        source: "github",
        skillName: "test",
        name: "Test",
        origin: "skills-sh",
        createdAt: NOW,
      });
      expect(result.origin).toBe("skills-sh");
    });
  });
});

// ---------------------------------------------------------------------------
// extension.ts
// ---------------------------------------------------------------------------
describe("extension schemas", () => {
  describe("ExtensionOriginSchema", () => {
    it("accepts 'marketplace'", () => {
      expect(ExtensionOriginSchema.parse("marketplace")).toBe("marketplace");
    });

    it("accepts 'manual'", () => {
      expect(ExtensionOriginSchema.parse("manual")).toBe("manual");
    });

    it("rejects 'github'", () => {
      expect(() => ExtensionOriginSchema.parse("github")).toThrow();
    });
  });

  describe("CreateExtensionInputSchema", () => {
    it("accepts valid input", () => {
      const result = CreateExtensionInputSchema.parse({
        _id: "ms-python.python",
        publisher: "ms-python",
        name: "Python",
        origin: "marketplace",
      });
      expect(result._id).toBe("ms-python.python");
    });

    it("accepts input with optional fields", () => {
      const result = CreateExtensionInputSchema.parse({
        _id: "ms-python.python",
        publisher: "ms-python",
        name: "Python",
        description: "Python language support",
        origin: "marketplace",
      });
      expect(result.description).toBe("Python language support");
    });

    it("rejects invalid extension ID format", () => {
      expect(() =>
        CreateExtensionInputSchema.parse({
          _id: "invalid",
          publisher: "p",
          name: "n",
          origin: "manual",
        }),
      ).toThrow();
    });

    it("rejects missing origin", () => {
      expect(() =>
        CreateExtensionInputSchema.parse({
          _id: "ms-python.python",
          publisher: "ms-python",
          name: "Python",
        }),
      ).toThrow();
    });
  });

  describe("ExtensionResponseSchema", () => {
    it("accepts valid response", () => {
      const result = ExtensionResponseSchema.parse({
        _id: "ms-python.python",
        publisher: "ms-python",
        name: "Python",
        origin: "marketplace",
        createdAt: NOW,
      });
      expect(result.publisher).toBe("ms-python");
    });

    it("accepts response with optional fields", () => {
      const result = ExtensionResponseSchema.parse({
        _id: "ms-python.python",
        publisher: "ms-python",
        name: "Python",
        description: "Python lang",
        origin: "manual",
        createdAt: NOW,
        updatedAt: NOW,
      });
      expect(result.description).toBe("Python lang");
    });
  });

  describe("ExtensionSearchResultSchema", () => {
    it("accepts valid search result", () => {
      const result = ExtensionSearchResultSchema.parse({
        id: "ms-python.python",
        name: "Python",
        publisher: "ms-python",
        internal: false,
      });
      expect(result.internal).toBe(false);
    });

    it("accepts result with optional fields", () => {
      const result = ExtensionSearchResultSchema.parse({
        id: "ms-python.python",
        name: "Python",
        publisher: "ms-python",
        description: "Python support",
        internal: true,
        version: "2024.22.1",
      });
      expect(result.version).toBe("2024.22.1");
    });
  });
});

// ---------------------------------------------------------------------------
// feature-flag.ts
// ---------------------------------------------------------------------------
describe("feature-flag schemas", () => {
  describe("FeatureFlagResponseSchema", () => {
    it("accepts valid response", () => {
      const result = FeatureFlagResponseSchema.parse({
        key: "dark_mode",
        label: "Dark Mode",
        enabled: true,
        updatedAt: NOW,
      });
      expect(result.enabled).toBe(true);
    });

    it("rejects missing enabled", () => {
      expect(() =>
        FeatureFlagResponseSchema.parse({ key: "k", label: "l", updatedAt: NOW }),
      ).toThrow();
    });
  });

  describe("UpdateFeatureFlagInputSchema", () => {
    it("accepts boolean enabled", () => {
      expect(UpdateFeatureFlagInputSchema.parse({ enabled: false }).enabled).toBe(false);
    });

    it("rejects non-boolean enabled", () => {
      expect(() => UpdateFeatureFlagInputSchema.parse({ enabled: "yes" })).toThrow();
    });
  });
});
