import { existsSync } from "node:fs";
import { mkdir, writeFile, copyFile, readdir } from "node:fs/promises";
import { join, basename, relative } from "node:path";
import AdmZip from "adm-zip";
import type { PublishInput } from "./types.js";

export async function generateFallbackPackage(
  platform: string,
  input: PublishInput,
  outputDir: string
): Promise<string> {
  await mkdir(outputDir, { recursive: true });
  const packageName = `${platform}-${Date.now()}`;
  const packageDir = join(outputDir, packageName);
  await mkdir(packageDir, { recursive: true });

  // 视频作品拷贝视频;图文作品(imagePaths 非空)没有视频,拷贝图片卡片
  // (2026-08-07:图文子作品发布失败时因缺 final.mp4 导致兜底包 ENOENT 500)
  const imagePaths = Array.isArray(input.options?.imagePaths)
    ? (input.options.imagePaths as unknown[]).filter((p): p is string => typeof p === "string" && p.length > 0)
    : [];

  let videoDestName: string | undefined;
  if (imagePaths.length === 0 && input.videoPath && existsSync(input.videoPath)) {
    const videoExt = input.videoPath.split(".").pop() || "mp4";
    const videoDest = join(packageDir, `video.${videoExt}`);
    await copyFile(input.videoPath, videoDest);
    videoDestName = basename(videoDest);
  }

  const imageDestNames: string[] = [];
  for (const p of imagePaths) {
    if (!existsSync(p)) continue;
    const dest = join(packageDir, basename(p));
    await copyFile(p, dest);
    imageDestNames.push(basename(dest));
  }

  let coverDest: string | undefined;
  if (input.coverPath && existsSync(input.coverPath)) {
    const coverExt = input.coverPath.split(".").pop() || "jpg";
    coverDest = join(packageDir, `cover.${coverExt}`);
    await copyFile(input.coverPath, coverDest);
  }

  const metadata: Record<string, unknown> = {
    platform,
    title: input.title,
    description: input.options?.description,
    tags: input.options?.tags,
    videoFile: videoDestName,
    imageFiles: imageDestNames.length > 0 ? imageDestNames : undefined,
    coverFile: coverDest ? basename(coverDest) : undefined,
  };
  const metadataPath = join(packageDir, "metadata.json");
  await writeFile(metadataPath, JSON.stringify(metadata, null, 2), "utf-8");

  const guide = buildManualGuide(platform, input);
  const guidePath = join(packageDir, "guide.md");
  await writeFile(guidePath, guide, "utf-8");

  const zipPath = join(outputDir, `${packageName}.zip`);
  const zip = new AdmZip();
  zip.addLocalFolder(packageDir, packageName);
  zip.writeZip(zipPath);

  return zipPath;
}

function buildManualGuide(platform: string, input: PublishInput): string {
  const tagsLine = (input.options?.tags as string[] | undefined)?.map((t) => `#${t}`).join(" ") ?? "";
  const hasImages = Array.isArray(input.options?.imagePaths) && (input.options.imagePaths as unknown[]).length > 0;
  const guides: Record<string, string> = {
    douyin: `# 抖音手动发布指南

1. 打开 https://creator.douyin.com/ 并登录账号。
2. 点击「上传视频」，选择本目录下的 video.*。
3. 标题：${input.title}
4. 话题标签：${tagsLine}
5. 简介：${input.options?.description ?? ""}
6. 确认无误后点击「发布」。`,
    xiaohongshu: hasImages
      ? `# 小红书手动发布指南（图文笔记）

1. 打开 https://creator.xiaohongshu.com/publish/publish 并登录。
2. 选择「上传图文」，按文件名顺序上传本目录下的 01-*.png 起全部图片。
3. 标题：${input.title}
4. 正文：${input.options?.description ?? ""}
5. 话题：${tagsLine}
6. 点击「发布」。`
      : `# 小红书手动发布指南

1. 打开 https://creator.xiaohongshu.com/publish/publish 并登录。
2. 选择「发布视频」，上传本目录下的 video.*。
3. 标题：${input.title}
4. 正文：${input.options?.description ?? ""}
5. 话题：${tagsLine}
6. 点击「发布」。`,
    channels: `# 微信视频号手动发布指南

1. 打开电脑版微信，进入「发现」→「视频号」。
2. 点击右上角人像图标 →「发表新动态」→「从相册选择」。
3. 选择本目录下的 video.* 作为视频，cover.* 作为封面（可选）。
4. 标题：${input.title}
5. 描述：${input.options?.description ?? ""}
6. 话题：${tagsLine}
7. 点击「发表」。`,
  };
  return guides[platform] ?? `# ${platform} 手动发布指南\n\n请使用 metadata.json 中的信息手动发布。`;
}
