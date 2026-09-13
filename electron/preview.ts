import type { Provider } from "./providers.js";
import type { Preview } from "../shared/types.js";

export async function preview(provider: Provider, p: string): Promise<Preview> {
  const info = await provider.stat(p);
  if (info.kind !== "file")
    return {
      kind: "unsupported",
      content:
        info.kind === "symlink"
          ? `링크 대상: ${await provider.readlink(p)}`
          : "이 항목은 미리보기를 지원하지 않습니다.",
    };
  const mime: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
  };
  const image = mime[provider.paths.extname(p).toLowerCase()];
  const limit = image ? 8 * 1024 * 1024 : 128 * 1024;
  if (image && info.size > limit)
    return {
      kind: "unsupported",
      content: "8 MB 이하의 이미지를 미리 볼 수 있습니다.",
    };
  const stream = provider.read(p);
  const chunks: Buffer[] = [];
  let length = 0;
  const timer = setTimeout(
    () => stream.destroy(new Error("미리보기 응답 시간이 초과되었습니다.")),
    30000,
  );
  try {
    for await (const chunk of stream) {
      const data = Buffer.from(chunk);
      chunks.push(data.subarray(0, limit - length));
      length += data.length;
      if (length >= limit) break;
    }
  } finally {
    clearTimeout(timer);
    stream.destroy();
  }
  const content = Buffer.concat(chunks);
  if (image)
    return {
      kind: "image",
      content: `data:${image};base64,${content.toString("base64")}`,
    };
  if (content.includes(0))
    return {
      kind: "unsupported",
      content: "바이너리 파일은 미리보기를 지원하지 않습니다.",
    };
  return {
    kind: "text",
    content: content.toString("utf8"),
    truncated: info.size > limit,
  };
}
