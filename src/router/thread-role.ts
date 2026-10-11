export type ThreadRole = "primary" | "side";

/**
 * Only the main agent carries a delegation tool (`task` in omp, `Task`/`Agent` in Claude Code);
 * its subagents and tool-less requests such as title generation never do, so they get a side
 * thread and can never rotate the primary.
 */
export function threadRole(req: { tools?: Array<{ name: string }> }, primaryToolNames: readonly string[]): ThreadRole {
  return req.tools?.some((tool) => primaryToolNames.includes(tool.name)) ? "primary" : "side";
}
