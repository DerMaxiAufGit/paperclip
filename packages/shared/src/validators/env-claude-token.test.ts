import { describe, expect, it } from "vitest";
import { createProjectSchema, updateProjectSchema } from "./project.js";
import { createRoutineSchema, updateRoutineSchema } from "./routine.js";
import { CLAUDE_CODE_OAUTH_TOKEN_UNSUPPORTED_MESSAGE } from "./secret.js";

type ParseResult = {
  success: boolean;
  error?: { issues: ReadonlyArray<{ message: string; path: PropertyKey[] }> };
};

function claudeTokenIssues(result: ParseResult) {
  return (result.error?.issues ?? []).filter(
    (issue) => issue.message === CLAUDE_CODE_OAUTH_TOKEN_UNSUPPORTED_MESSAGE,
  );
}

const cases: Array<{ name: string; parse: (env: unknown) => ParseResult }> = [
  { name: "createProjectSchema", parse: (env) => createProjectSchema.safeParse({ name: "Project", env }) },
  { name: "updateProjectSchema", parse: (env) => updateProjectSchema.safeParse({ env }) },
  { name: "createRoutineSchema", parse: (env) => createRoutineSchema.safeParse({ title: "Routine", env }) },
  { name: "updateRoutineSchema", parse: (env) => updateRoutineSchema.safeParse({ env }) },
];

describe("project and routine env Claude subscription token rejection", () => {
  for (const { name, parse } of cases) {
    it(`${name} rejects CLAUDE_CODE_OAUTH_TOKEN in any letter case`, () => {
      for (const key of ["CLAUDE_CODE_OAUTH_TOKEN", "claude_code_oauth_token"]) {
        const result = parse({ [key]: { type: "plain", value: "x" } });
        expect(result.success).toBe(false);
        const issues = claudeTokenIssues(result);
        expect(issues).toHaveLength(1);
        expect(issues[0]?.path).toEqual(["env", key]);
      }
    });

    it(`${name} still accepts an API key`, () => {
      const result = parse({ ANTHROPIC_API_KEY: { type: "plain", value: "sk-ant-api" } });
      expect(result.success).toBe(true);
    });
  }
});

describe("issue assignee adapter override Claude subscription token rejection", () => {
  it("rejects CLAUDE_CODE_OAUTH_TOKEN in the override adapterConfig.env", async () => {
    const { createIssueSchema } = await import("./issue.js");
    const result = createIssueSchema.safeParse({
      title: "Run",
      assigneeAdapterOverrides: {
        adapterConfig: { env: { claude_code_oauth_token: { type: "plain", value: "x" } } },
      },
    });
    expect(result.success).toBe(false);
    expect(claudeTokenIssues(result)).toHaveLength(1);
    const ok = createIssueSchema.safeParse({
      title: "Run",
      assigneeAdapterOverrides: { adapterConfig: { model: "claude-opus" } },
    });
    expect(ok.success).toBe(true);
  });
});
