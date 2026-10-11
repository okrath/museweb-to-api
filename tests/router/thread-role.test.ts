import { describe, expect, it } from "vitest";
import { threadRole } from "../../src/router/thread-role.js";

const DEFAULTS = ["task", "Task", "Agent"];

describe("threadRole", () => {
  it("classifies omp main agent carrying the delegation tool (task) as primary", () => {
    const req = {
      tools: [
        { name: "bash" },
        { name: "read" },
        { name: "task" },
        { name: "edit" },
      ],
    };
    expect(threadRole(req, DEFAULTS)).toBe("primary");
  });

  it("classifies omp subagent (glob, grep, read, web_search, yield) without delegation as side", () => {
    const req = {
      tools: [
        { name: "glob" },
        { name: "grep" },
        { name: "read" },
        { name: "web_search" },
        { name: "yield" },
      ],
    };
    expect(threadRole(req, DEFAULTS)).toBe("side");
  });

  it("classifies Claude Code carrying Agent tool as primary", () => {
    const req = {
      tools: [
        { name: "Agent" },
        { name: "Bash" },
        { name: "Read" },
      ],
    };
    expect(threadRole(req, DEFAULTS)).toBe("primary");
  });

  it("classifies capitalized Task tool as primary", () => {
    const req = {
      tools: [{ name: "Task" }],
    };
    expect(threadRole(req, DEFAULTS)).toBe("primary");
  });

  it("classifies tool-less requests (title/summary or plain chat) as side", () => {
    expect(threadRole({ tools: [] }, DEFAULTS)).toBe("side");
    expect(threadRole({ tools: undefined }, DEFAULTS)).toBe("side");
    expect(threadRole({}, DEFAULTS)).toBe("side");
  });

  it("supports custom primaryToolNames as an array", () => {
    const req = { tools: [{ name: "custom_delegate" }] };
    expect(threadRole(req, ["custom_delegate", "subtask"])).toBe("primary");
    expect(threadRole(req, ["other_tool"])).toBe("side");
  });
});
