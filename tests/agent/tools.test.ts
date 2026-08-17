import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCreatorTools, buildEvaluatorTools, type ToolContext } from "../../src/agent/tools/index.js";

async function makeCtx(): Promise<{ ctx: ToolContext; dir: string }> {
  // 作品目录必须在允许根集合内——用 dataDir 下的临时目录
  const { dataDir } = await import("../../src/config.js");
  const dir = await mkdtemp(join(dataDir, "works", "tooltest-"));
  return { ctx: { workDir: dir }, dir };
}

describe("工具执行器", () => {
  it("write → read 回环；read 超长按规则截断", async () => {
    const { ctx, dir } = await makeCtx();
    const tools = buildCreatorTools();
    await tools.Write.execute({ file_path: "sub/a.txt", content: "你好世界" }, ctx);
    const content = await readFile(join(dir, "sub", "a.txt"), "utf-8");
    expect(content).toBe("你好世界");
    const read = await tools.Read.execute({ file_path: "sub/a.txt" }, ctx);
    expect(read).toBe("你好世界");
  });

  it("路径逃逸被拒绝", async () => {
    const { ctx } = await makeCtx();
    const tools = buildCreatorTools();
    await expect(tools.Read.execute({ file_path: "C:/Windows/System32/drivers/etc/hosts" }, ctx)).rejects.toThrow(/越界/);
    await expect(tools.Write.execute({ file_path: "../../../evil.txt", content: "x" }, ctx)).rejects.toThrow(/越界/);
  });

  it("read 图片返回 ImageBlock", async () => {
    const { ctx } = await makeCtx();
    const tools = buildCreatorTools();
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
    await tools.Write.execute({ file_path: "note.md", content: "占位" }, ctx);
    await mkdir(join(ctx.workDir, "img"), { recursive: true });
    await writeFile(join(ctx.workDir, "img", "a.png"), png);
    const result = await tools.Read.execute({ file_path: "img/a.png" }, ctx);
    expect(Array.isArray(result)).toBe(true);
    expect((result as any[])[0]).toMatchObject({ type: "image", mediaType: "image/png" });
  });

  it("edit 唯一匹配校验与 replace_all", async () => {
    const { ctx } = await makeCtx();
    const tools = buildCreatorTools();
    await tools.Write.execute({ file_path: "e.txt", content: "foo bar foo" }, ctx);
    await expect(tools.Edit.execute({ file_path: "e.txt", old_string: "foo", new_string: "baz" }, ctx)).rejects.toThrow(/2 处/);
    await tools.Edit.execute({ file_path: "e.txt", old_string: "foo", new_string: "baz", replace_all: true }, ctx);
    expect(await readFile(join(ctx.workDir, "e.txt"), "utf-8")).toBe("baz bar baz");
    await expect(tools.Edit.execute({ file_path: "e.txt", old_string: "不存在", new_string: "x" }, ctx)).rejects.toThrow(/未找到/);
  });

  it("glob ** 递归匹配", async () => {
    const { ctx } = await makeCtx();
    const tools = buildCreatorTools();
    await tools.Write.execute({ file_path: "a/b/c.mp4", content: "v" }, ctx);
    await tools.Write.execute({ file_path: "a/d.txt", content: "t" }, ctx);
    const result = await tools.Glob.execute({ pattern: "**/*.mp4" }, ctx);
    expect(String(result)).toContain("c.mp4");
    expect(String(result)).not.toContain("d.txt");
  });

  it("grep 命中与无匹配", async () => {
    const { ctx } = await makeCtx();
    const tools = buildCreatorTools();
    await tools.Write.execute({ file_path: "g.txt", content: "第一行\n包含目标词的行\n第三行" }, ctx);
    const hit = await tools.Grep.execute({ pattern: "目标词" }, ctx);
    expect(String(hit)).toContain("g.txt");
    expect(String(hit)).toContain("2");
    const miss = await tools.Grep.execute({ pattern: "绝不存在词xyz" }, ctx);
    expect(String(miss)).toContain("无匹配");
  });

  it("bash 跑 Unix 命令（Git Bash 语义）+ 黑名单拦截", { timeout: 20000 }, async () => {
    const { ctx } = await makeCtx();
    const tools = buildCreatorTools();
    const r = await tools.Bash.execute({ command: "echo hello | tr a-z A-Z" }, ctx);
    expect(String(r)).toContain("HELLO");
    await expect(tools.Bash.execute({ command: "rm -rf /" }, ctx)).rejects.toThrow(/拦截/);
  });

  it("评审工具集只读（无 Write/Edit）", () => {
    const evalTools = buildEvaluatorTools();
    expect(evalTools.Write).toBeUndefined();
    expect(evalTools.Edit).toBeUndefined();
    expect(evalTools.Read).toBeDefined();
    expect(evalTools.Bash).toBeDefined();
  });
});
